// The implementation council — the tools for the write/verify/fix loop.
//
// Mirrors src/plan.js in shape. The differences are that the author moves first, because
// there is nothing to verify until the code exists, and that the server measures the diff
// itself rather than trusting the author's account of its own change.

import { z } from "zod";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

import {
  transact,
  getImplCouncil,
  getUnfinishedImplCouncil,
  getLatestImplCouncil,
  createImplCouncil,
  getImplSteps,
  joinImplCouncil,
  getImplParticipants,
  appendImplStep,
  setImplStatus,
  setImplRound,
  getCouncil,
  getPlanCouncil,
} from "./db.js";
import {
  AUTHOR,
  CRITIC,
  VERDICTS_IMPL,
  MATCHES,
  LIMITS_IMPL,
  implState,
  validateReport,
  validateReview,
  validateDecision,
  REPORT_INSTRUCTION,
  REVIEW_INSTRUCTION,
  DECIDED_INSTRUCTION,
} from "./impl-rules.js";
import {
  councilDir,
  makeGoalId,
  writeImplBrief,
  writeImplStep,
  writeImplTrail,
  implSummaryBlock,
} from "./render.js";

const AGENTS = [AUTHOR, CRITIC];
const TERMINAL = ["ready", "capped", "error", "aborted"];

/** Read-only git, never allowed to hang a tool call. Null on any failure. */
function git(cwd, args) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/**
 * The change so far, measured by the server rather than reported by its author.
 *
 * This is the improvement over the plan council's file digest: the side that wrote the code
 * is not the side saying how much of it there is.
 */
function diffStats(council) {
  const out = git(council.project_path, ["diff", council.base_ref]);
  if (out === null) return { diff_digest: null, diff_lines: null };
  return {
    diff_digest: createHash("sha256").update(out).digest("hex").slice(0, 16),
    diff_lines: out === "" ? 0 : out.split("\n").length,
  };
}

export function registerImplTools(server, deps) {
  const {
    db,
    ok,
    fail,
    sleep,
    log,
    pollBudgetMs,
    pollIntervalMs,
    joinWaitMs,
    stepWaitMs,
    staleAfterMs,
    unfinishedElsewhere,
    sweepStale,
  } = deps;

  const steps = (goalId) => getImplSteps(db(), goalId);
  const stateOf = (c) => implState(steps(c.goal_id), c.max_rounds);
  const joined = (goalId) => getImplParticipants(db(), goalId).map((p) => p.agent);

  const instructionFor = (state, all) => {
    if (state.phase === "review") return REVIEW_INSTRUCTION;
    if (state.phase !== "report") return null;
    return all.at(-1)?.kind === "decision" ? DECIDED_INSTRUCTION : REPORT_INSTRUCTION;
  };

  /** Write back the status and round the steps imply, inside the caller's transaction. */
  function sync(council) {
    const state = implState(steps(council.goal_id), council.max_rounds);
    const wanted = state.status ?? "active";
    if (council.status !== wanted) {
      setImplStatus(db(), council.goal_id, wanted, state.reason ?? null);
    }
    if (council.round !== state.round) setImplRound(db(), council.goal_id, state.round);
    return state;
  }

  /** The latest sign of life — a join counts, so re-triggering the skill restarts the clock. */
  function lastActivityAt(council, all) {
    const times = [new Date(council.started_at).getTime()];
    for (const p of getImplParticipants(db(), council.goal_id)) {
      times.push(new Date(p.joined_at).getTime());
    }
    if (all.length) times.push(new Date(all.at(-1).created_at).getTime());
    return Math.max(...times);
  }

  function view(council, agent) {
    const all = steps(council.goal_id);
    const state = implState(all, council.max_rounds);
    const report = [...all].reverse().find((s) => s.kind === "report") ?? null;
    const review = [...all].reverse().find((s) => s.kind === "review") ?? null;
    const here = joined(council.goal_id);

    return {
      goal_id: council.goal_id,
      task: council.task,
      project_path: council.project_path,
      plan_path: council.plan_path ?? null,
      plan_scope: council.plan_scope ?? null,
      base_ref: council.base_ref,
      dirty_at_open: Boolean(council.dirty_at_open),
      round: state.round,
      max_rounds: council.max_rounds,
      final_round: state.round >= council.max_rounds,
      status: council.status,
      stop_reason: council.stop_reason ?? null,
      record_path: councilDir(council.goal_id),
      author: AUTHOR,
      critic: CRITIC,
      your_role: agent === AUTHOR ? "author" : "critic",
      participants: here,
      peer_joined: here.includes(agent === AUTHOR ? CRITIC : AUTHOR),
      phase: state.phase,
      next_actor: state.actor ?? null,
      reviews_so_far: all.filter((s) => s.kind === "review").length,
      ...diffStats(council),
      latest_report: report
        ? {
            round: report.round,
            summary: report.summary,
            applied: report.applied,
            rejected: report.rejected,
            needs_user_decision: report.needs_user,
          }
        : null,
      latest_review: review
        ? {
            round: review.round,
            findings: review.findings,
            blockers: review.blockers,
            highs: review.highs,
            mediums: review.mediums,
            lows: review.lows,
            gaps: review.gaps,
            coverage: review.coverage,
            verdict: review.verdict,
            verification: review.verification,
            report_matches_diff: review.report_matches_diff,
            mismatch: review.mismatch,
            plan_defect: review.plan_defect,
          }
        : null,
    };
  }

  function nextStep(council, agent, state) {
    if (state.phase === "final") {
      return council.status === "ready"
        ? "The critic verified the implementation. Call impl_council_close and tell the user " +
            "it is complete, with what was checked."
        : "The council has stopped. Call impl_council_close and show the user why.";
    }
    if (state.phase === "user") {
      return (
        "Stop and hand back to the user. Show them the open question — either the author's " +
        "needs_user_decision or the critic's plan_defect. When they answer, call " +
        "impl_council_resume."
      );
    }
    if (state.actor === agent) {
      return state.phase === "report"
        ? `Do the work for round ${state.round}, then record it with impl_council_report.`
        : `Verify round ${state.round} with impl_council_review.`;
    }
    const peerHere = joined(council.goal_id).includes(state.actor);
    return (
      `Waiting on ${state.actor} to ${state.phase}. Call impl_council_await, and keep calling ` +
      "it while it answers retry:true — the server ends the wait itself. " +
      (peerHere
        ? `${state.actor} has joined and is working.`
        : `${state.actor} has not joined yet — tell the user to run the skill in that window.`)
    );
  }

  const reply = (council, agent, extra = {}) => {
    const all = steps(council.goal_id);
    const state = implState(all, council.max_rounds);
    return ok({
      ok: true,
      ...view(council, agent),
      next_step: nextStep(council, agent, state),
      ...(state.actor === agent ? { instruction: instructionFor(state, all) } : {}),
      ...extra,
    });
  };

  function requireOpen(goalId) {
    const council = getImplCouncil(db(), goalId);
    if (!council) throw new Error(`no implementation council with goal_id ${goalId}`);
    if (council.status === "aborted") throw new Error("this council was abandoned");
    if (council.status === "error") throw new Error(`this council failed — ${council.stop_reason}`);
    if (council.status === "needs_user") {
      throw new Error(
        "this council is waiting on a decision from the user. Relay it with " +
          "impl_council_resume before going on.",
      );
    }
    return council;
  }

  /** Same-task councils are a resume, not a leftover. `force` is the user saying start over. */
  function sweepForOpen(task, force = false) {
    return sweepStale(db(), force ? -1 : staleAfterMs, {
      agent: AUTHOR,
      protect: (mode, council) =>
        !force && mode.name === "impl_council" && council.task === task,
    });
  }

  /** What the author is being offered when work already exists. Null when nothing is at stake. */
  function resumeOffer(council) {
    const all = steps(council.goal_id);
    if (!all.length) return null;
    const state = implState(all, council.max_rounds);
    const review = [...all].reverse().find((s) => s.kind === "review") ?? null;
    return {
      round: state.round,
      phase: state.phase,
      next_actor: state.actor ?? null,
      minutes_old: Math.round((Date.now() - new Date(all.at(-1).created_at).getTime()) / 60_000),
      waiting_review: review
        ? `${review.blockers} Blocker, ${review.highs} High, ${review.mediums} Medium, ` +
          `${review.gaps} gap(s) — ${review.verdict}`
        : null,
    };
  }

  registerOpen();
  registerReport();
  registerReview();
  registerAwait();
  registerResume();
  registerClose();

  // -------------------------------------------------------------------------

  function registerOpen() {
    server.registerTool(
      "impl_council_open",
      {
        title: "Open or join an implementation council",
        description:
          "Start the write/verify loop on a piece of work, or join the one the peer started. " +
          "The author calls this BEFORE touching any code, so the base commit is honest. " +
          "claude implements, codex verifies against the diff and against the plan if given.",
        inputSchema: {
          agent: z.enum(AGENTS).describe("Which model you are."),
          task: z
            .string()
            .max(LIMITS_IMPL.short)
            .optional()
            .describe("What the user asked for, in their words. Required when starting."),
          project_path: z.string().optional().describe("Absolute path. Required when starting."),
          plan_path: z
            .string()
            .optional()
            .describe("The plan this implements, if there is one. Completeness is judged against it."),
          plan_scope: z
            .string()
            .max(LIMITS_IMPL.short)
            .optional()
            .describe(
              "Which part of the plan is in scope — 'W1 and W2A'. Omit only when the whole " +
                "plan is meant to be done now, or the critic will report the rest as missing.",
            ),
          base_ref: z
            .string()
            .optional()
            .describe(
              "What to measure the change from. Defaults to HEAD, which is right when the " +
                "work has not started. Pass HEAD~1, a branch, or a commit to review work " +
                "that is already committed — otherwise the base contains it and the diff " +
                "is empty.",
            ),
          git_branch: z.string().optional(),
          max_rounds: z.number().int().min(1).max(10).optional().describe("Default 5."),
          fresh: z
            .boolean()
            .optional()
            .describe("Abandon the council on this task and start again. Only when the user says so."),
        },
      },
      async ({
        agent,
        task,
        project_path,
        plan_path,
        plan_scope,
        base_ref,
        git_branch,
        max_rounds = 5,
        fresh = false,
      }) => {
        try {
          const cleared = agent === AUTHOR && task ? sweepForOpen(task, fresh) : [];

          const [blocked] = unfinishedElsewhere(db(), agent, "impl_council");
          if (blocked) {
            return fail(
              `you have an unfinished ${blocked.mode.label}: ${blocked.brief.goal_id} ` +
                `(${blocked.brief.status}). Finish it, or release it with council_abandon, ` +
                "before starting an implementation council. Closing does not release anything.",
              {
                blocking_goal_id: blocked.brief.goal_id,
                blocking_mode: blocked.mode.name,
                release_with: "council_abandon",
              },
            );
          }

          const council = transact(db(), () => {
            const existing = getUnfinishedImplCouncil(db());
            if (existing) {
              joinImplCouncil(db(), existing.goal_id, agent);
              return existing;
            }

            // The author starts it, because only the author knows what was asked and what
            // the tree looked like before they touched it.
            if (agent !== AUTHOR) {
              throw new Error(
                `${AUTHOR} starts an implementation council. No council is open yet: tell the ` +
                  `user to run the skill in the ${AUTHOR} window, then call this again. Do not ` +
                  "open one yourself — you would be guessing at what was asked.",
              );
            }
            if (!task) throw new Error("task is required when starting an implementation council");
            if (!project_path) throw new Error("project_path is required when starting");

            // Default HEAD, which is right when the work has not started yet. A caller
            // reviewing work that is already committed has to name an earlier ref, or the
            // base contains the very change under review and the diff comes out empty.
            const wanted = base_ref ?? "HEAD";
            const resolved = git(project_path, ["rev-parse", "--verify", `${wanted}^{commit}`]);
            if (!resolved) {
              throw new Error(
                base_ref
                  ? `${project_path} has no commit at ${base_ref}. Pass a ref git can resolve ` +
                    "— HEAD~1, a branch name, or a commit sha."
                  : `${project_path} is not a git repository, or has no commits yet. This mode ` +
                    "measures the change as a diff from a base commit, so it needs one.",
              );
            }
            const head = resolved;
            const status = git(project_path, ["status", "--porcelain"]);

            const id = makeGoalId(
              `impl ${task}`,
              (candidate) =>
                getImplCouncil(db(), candidate) !== null ||
                getPlanCouncil(db(), candidate) !== null ||
                getCouncil(db(), candidate) !== null,
            );
            const fresh_ = createImplCouncil(db(), {
              goalId: id,
              task,
              projectPath: project_path,
              gitBranch: git_branch,
              planPath: plan_path,
              planScope: plan_scope,
              baseRef: head.trim(),
              dirtyAtOpen: Boolean(status && status.trim() !== ""),
              maxRounds: max_rounds,
            });
            joinImplCouncil(db(), id, agent);
            return fresh_;
          });

          writeImplBrief(council);
          log(`impl open: ${council.goal_id} agent=${agent} base=${council.base_ref.slice(0, 8)}`);

          const offer = agent === AUTHOR && !fresh ? resumeOffer(council) : null;
          return reply(council, agent, {
            ...(cleared.length ? { cleared } : {}),
            ...(offer
              ? {
                  resuming: offer,
                  instruction: undefined,
                  next_step:
                    "Stop. Show the user what is in `resuming` and ask whether to resume or " +
                    "start over. Start over means calling impl_council_open again with " +
                    "fresh:true, which discards this council.",
                }
              : {}),
            // Dirty at open has two very different meanings and the council cannot tell
            // them apart. Say both, and make the author pick — reporting it only as
            // "work that predates this task" reads exactly backwards when the uncommitted
            // changes ARE the work being verified.
            ...(council.dirty_at_open && !offer
              ? {
                  warning:
                    "The working tree already had uncommitted changes when this opened, so " +
                    "they are inside the diff from base. Either they are the work you are " +
                    "having verified — which is fine, and is how you review something already " +
                    "written — or they are unrelated changes that will be reviewed by " +
                    "accident. Say which, to the user and in your report.",
                }
              : {}),
          });
        } catch (error) {
          return fail(error.message);
        }
      },
    );
  }

  // -------------------------------------------------------------------------

  function registerReport() {
    server.registerTool(
      "impl_council_report",
      {
        title: "Report what you implemented",
        description:
          "Record what you changed and why. Only the author may call this. The critic reads " +
          "the real diff, so anything you touched and did not mention is itself a finding.",
        inputSchema: {
          goal_id: z.string(),
          agent: z.enum(AGENTS),
          summary: z
            .string()
            .max(LIMITS_IMPL.block)
            .describe("What you changed and why, file by file where it matters. Markdown."),
          applied: z
            .string()
            .max(LIMITS_IMPL.block)
            .optional()
            .describe("What you applied from the last review. 'None.' on round 1."),
          rejected: z
            .string()
            .max(LIMITS_IMPL.block)
            .optional()
            .describe("Review points you did not apply, each with the reason. 'None.' if none."),
          needs_user_decision: z
            .string()
            .max(LIMITS_IMPL.block)
            .optional()
            .describe("Unresolved choices that are the user's. Anything here stops the council."),
        },
      },
      async ({ goal_id, agent, ...fields }) => {
        try {
          const result = transact(db(), () => {
            const council = requireOpen(goal_id);
            const state = stateOf(council);
            if (agent !== AUTHOR) throw new Error(`${AUTHOR} implements; you are the critic`);
            if (state.phase !== "report") {
              throw new Error(
                state.phase === "review"
                  ? `nothing to report: waiting on ${CRITIC} to verify round ${state.round}`
                  : `the council has stopped — ${state.reason}`,
              );
            }
            const seq = appendImplStep(db(), goal_id, {
              ...validateReport(fields, state.round),
              ...diffStats(council),
            });
            sync(council);
            return { seq, round: state.round };
          });

          const council = getImplCouncil(db(), goal_id);
          writeImplStep(goal_id, steps(goal_id).find((s) => s.seq === result.seq));
          log(`impl report: ${goal_id} round=${result.round} status=${council.status}`);

          // Nothing to verify. Usually the base is wrong: work that was already committed
          // sits inside HEAD, so the diff against it is empty and the critic would review
          // nothing and approve it. That silent approval is the worst outcome this mode has.
          const { diff_lines } = diffStats(council);
          return reply(council, agent, {
            ...(diff_lines === 0
              ? {
                  warning:
                    `The diff against ${council.base_ref.slice(0, 8)} is empty — there is ` +
                    "nothing for the critic to verify. If the work is already committed, the " +
                    "base contains it: abandon this council and open a new one with a base_ref " +
                    "from before the work, such as HEAD~1. Tell the user rather than letting " +
                    "the critic approve an empty change.",
                }
              : {}),
          });
        } catch (error) {
          return fail(error.message, { field: error.field ?? null });
        }
      },
    );
  }

  // -------------------------------------------------------------------------

  function registerReview() {
    server.registerTool(
      "impl_council_review",
      {
        title: "Verify the implementation",
        description:
          "Record whether the work is complete and correct. Only the critic may call this. " +
          "Approve is refused with Blocker or High findings, with unimplemented scope, with " +
          "no verification, or while the report does not match the diff.",
        inputSchema: {
          goal_id: z.string(),
          agent: z.enum(AGENTS),
          findings: z
            .string()
            .max(LIMITS_IMPL.block)
            .describe("Every issue, with severity and a file:line citation. Markdown."),
          blockers: z.number().int().min(0),
          highs: z.number().int().min(0),
          mediums: z.number().int().min(0),
          lows: z.number().int().min(0),
          gaps: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe("Items in the plan's scope not implemented. Always blocks approval."),
          coverage: z
            .string()
            .max(LIMITS_IMPL.block)
            .optional()
            .describe("Which scope items are done, partial or missing. Required when gaps > 0."),
          verification: z
            .string()
            .max(LIMITS_IMPL.block)
            .describe(
              "What you actually checked and how it came out. A test run, or the reading that " +
                "proves nothing breaks. 'Looks correct' is not verification.",
            ),
          report_matches_diff: z
            .enum(MATCHES)
            .describe("Does the author's report account for everything the diff changes?"),
          mismatch: z
            .string()
            .max(LIMITS_IMPL.short)
            .optional()
            .describe("Required when no. What is claimed and absent, or present and unmentioned."),
          plan_defect: z
            .string()
            .max(LIMITS_IMPL.short)
            .optional()
            .describe(
              "Only when a step in the plan itself cannot work as written. Parks the council " +
                "for the user — the plan already survived its own council.",
            ),
          verdict: z.enum(VERDICTS_IMPL),
        },
      },
      async ({ goal_id, agent, ...fields }) => {
        try {
          const result = transact(db(), () => {
            const council = requireOpen(goal_id);
            const state = stateOf(council);
            if (agent !== CRITIC) throw new Error(`${CRITIC} verifies; you are the author`);
            if (state.phase !== "review") {
              throw new Error(
                state.phase === "report"
                  ? `nothing to verify yet: waiting on ${AUTHOR} for round ${state.round}`
                  : `the council has stopped — ${state.reason}`,
              );
            }
            const seq = appendImplStep(db(), goal_id, {
              ...validateReview(fields, state.round, Boolean(council.plan_path)),
              ...diffStats(council),
            });
            sync(council);
            return { seq, round: state.round };
          });

          const council = getImplCouncil(db(), goal_id);
          writeImplStep(goal_id, steps(goal_id).find((s) => s.seq === result.seq));
          log(`impl review: ${goal_id} round=${result.round} status=${council.status}`);
          return reply(council, agent);
        } catch (error) {
          return fail(error.message, { field: error.field ?? null });
        }
      },
    );
  }

  // -------------------------------------------------------------------------

  function registerAwait() {
    server.registerTool(
      "impl_council_await",
      {
        title: "Wait for your turn",
        description:
          "Block until it is your move, or the council stops. retry:true means call again — " +
          "keep calling. The author may work for a long time before the first report.",
        inputSchema: { goal_id: z.string(), agent: z.enum(AGENTS) },
      },
      async ({ goal_id, agent }) => {
        try {
          if (!getImplCouncil(db(), goal_id)) {
            return fail(`no implementation council with goal_id ${goal_id}`);
          }

          const deadline = Date.now() + pollBudgetMs;
          while (Date.now() < deadline) {
            const council = getImplCouncil(db(), goal_id);

            if (TERMINAL.includes(council.status)) {
              return reply(council, agent, {
                arrived: ["ready", "capped"].includes(council.status),
                retry: false,
                note: `the council is ${council.status}; stop waiting`,
              });
            }

            const all = steps(goal_id);
            const state = implState(all, council.max_rounds);

            // Parked on the user. Release at once, and do not let the stall timer run.
            if (state.phase === "user") {
              return reply(council, agent, {
                arrived: false,
                retry: false,
                note: "waiting on the user to decide, not on the peer. Show them the question.",
              });
            }

            if (state.actor === agent) {
              return reply(council, agent, { arrived: true, retry: false });
            }

            const peerHere = joined(goal_id).includes(state.actor);
            const budget = peerHere ? stepWaitMs : joinWaitMs;
            const waited = Date.now() - lastActivityAt(council, all);

            if (waited > budget) {
              const minutes = Math.max(1, Math.round(waited / 60_000));
              if (!peerHere) {
                return reply(council, agent, {
                  arrived: false,
                  retry: false,
                  waited_minutes: minutes,
                  note:
                    `${state.actor} has not joined after ${minutes} minutes. Tell the user to ` +
                    "run the skill in that window — this council stays open, so call " +
                    "impl_council_await again once they have.",
                });
              }
              transact(db(), () =>
                setImplStatus(
                  db(),
                  goal_id,
                  "error",
                  `${state.actor} joined but did not ${state.phase} round ${state.round} ` +
                    `within ${minutes} minutes`,
                ),
              );
              return reply(getImplCouncil(db(), goal_id), agent, {
                arrived: false,
                retry: false,
                note: `${state.actor} stopped responding. The code is untouched by this.`,
              });
            }

            await sleep(pollIntervalMs);
          }

          const council = getImplCouncil(db(), goal_id);
          const state = stateOf(council);
          const peerHere = joined(goal_id).includes(state.actor);
          const left = Math.max(
            0,
            (peerHere ? stepWaitMs : joinWaitMs) -
              (Date.now() - lastActivityAt(council, steps(goal_id))),
          );
          return reply(council, agent, {
            arrived: false,
            retry: true,
            waited_seconds: Math.round(pollBudgetMs / 1000),
            minutes_left: Math.round(left / 60_000),
            note:
              `Waiting on ${state.actor} to ${state.phase}. Call impl_council_await again — ` +
              "keep calling while it answers retry:true. The server ends the wait itself; do " +
              "not decide the peer is absent. " +
              (peerHere
                ? `${state.actor} has joined and is working. Writing code takes a while.`
                : `${state.actor} has not joined — tell the user to run the skill there.`),
          });
        } catch (error) {
          return fail(error.message);
        }
      },
    );
  }

  // -------------------------------------------------------------------------

  function registerResume() {
    server.registerTool(
      "impl_council_resume",
      {
        title: "Give the council the user's decision",
        description:
          "Record what the user decided — about the author's open question or the critic's " +
          "plan_defect — and hand the loop back to the author. The round does not advance.",
        inputSchema: {
          agent: z.enum(AGENTS),
          decision: z.string().max(LIMITS_IMPL.short).describe("What the user decided."),
          goal_id: z.string().optional().describe("Defaults to the parked council."),
        },
      },
      async ({ agent, decision, goal_id }) => {
        try {
          const result = transact(db(), () => {
            const council = goal_id
              ? getImplCouncil(db(), goal_id)
              : getUnfinishedImplCouncil(db());
            if (!council) {
              throw new Error(
                goal_id ? `no council with goal_id ${goal_id}` : "no implementation council to resume",
              );
            }
            if (council.status !== "needs_user") {
              throw new Error(`this council is ${council.status}, not waiting on a decision.`);
            }
            const state = stateOf(council);
            const seq = appendImplStep(db(), council.goal_id, {
              kind: "decision",
              actor: "user",
              round: state.round,
              decision: validateDecision(decision),
              ...diffStats(council),
            });
            sync(council);
            return { goalId: council.goal_id, seq };
          });

          const council = getImplCouncil(db(), result.goalId);
          writeImplStep(result.goalId, steps(result.goalId).find((s) => s.seq === result.seq));
          log(`impl resume: ${result.goalId} relayed by=${agent}`);
          return reply(council, agent);
        } catch (error) {
          return fail(error.message, { field: error.field ?? null });
        }
      },
    );
  }

  // -------------------------------------------------------------------------

  function registerClose() {
    server.registerTool(
      "impl_council_close",
      {
        title: "Render the trail",
        description: "Write trail.md and return the summary. Safe to call twice.",
        inputSchema: { agent: z.enum(AGENTS), goal_id: z.string().optional() },
      },
      async ({ agent, goal_id }) => {
        try {
          const council = goal_id
            ? getImplCouncil(db(), goal_id)
            : (getUnfinishedImplCouncil(db()) ?? getLatestImplCouncil(db()));
          if (!council) {
            return fail(goal_id ? `no council with goal_id ${goal_id}` : "no implementation council");
          }
          const all = steps(council.goal_id);
          const path = writeImplTrail(council, all);
          log(`impl close: ${council.goal_id} status=${council.status} steps=${all.length}`);
          return reply(council, agent, {
            trail_path: path,
            summary: implSummaryBlock(council, all),
          });
        } catch (error) {
          return fail(error.message);
        }
      },
    );
  }
}
