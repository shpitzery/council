// The plan council — the tools for the critique/resolve loop.
//
// Registered on the same server as the debate mode, sharing its database so the
// one-at-a-time guard can see across both. Everything shared with server.js is passed in
// rather than imported, so nothing over there has to be rearranged to make room.

import { z } from "zod";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  transact,
  getPlanCouncil,
  getUnfinishedPlanCouncil,
  getLatestPlanCouncil,
  createPlanCouncil,
  getPlanSteps,
  joinPlanCouncil,
  getPlanParticipants,
  appendPlanStep,
  setPlanStatus,
  setPlanRound,
  getCouncil,
} from "./db.js";
import {
  AUTHOR,
  CRITIC,
  CRITIC_READINESS,
  AUTHOR_READINESS,
  LIMITS_PLAN,
  planState,
  validateCritique,
  validateResolve,
  validateDecision,
  CRITIQUE_INSTRUCTION,
  RESOLVE_INSTRUCTION,
  DECIDED_INSTRUCTION,
} from "./plan-rules.js";
import {
  councilDir,
  makeGoalId,
  writePlanBrief,
  writePlanStep,
  writePlanTrail,
  planSummaryBlock,
} from "./render.js";

const AGENTS = [AUTHOR, CRITIC];

/**
 * The plan file as it stands right now: a fingerprint, and how long it is.
 *
 * The fingerprint lets a resume tell whether the plan moved since the critique was written,
 * because resolving a critique against a rewritten plan produces confident objections to
 * paragraphs that no longer exist.
 *
 * The line count exists because this loop only ever adds. Every round integrates findings
 * and none removes anything, so a plan can quietly swell into a specification over ten
 * rounds — one real run grew to 1797 lines with no one noticing until the end. Reporting the
 * size every round makes that visible while it is still happening.
 *
 * Nulls when the file cannot be read. The council never depends on reading the plan, so an
 * unreadable one is a missing check rather than a failure.
 */
function planStats(path) {
  try {
    const body = readFileSync(path);
    return {
      plan_digest: createHash("sha256").update(body).digest("hex").slice(0, 16),
      plan_lines: body.toString("utf8").split("\n").length,
    };
  } catch {
    return { plan_digest: null, plan_lines: null };
  }
}

// Anything the kill switch or a stall can set. An await must release on all of them.
const TERMINAL = ["ready", "capped", "error", "aborted"];

export function registerPlanTools(server, deps) {
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

  const steps = (goalId) => getPlanSteps(db(), goalId);
  const stateOf = (council) => planState(steps(council.goal_id), council.max_rounds);

  const instructionFor = (state, all) => {
    if (state.phase === "critique") return CRITIQUE_INSTRUCTION;
    if (state.phase !== "resolve") return null;
    return all.at(-1)?.kind === "decision" ? DECIDED_INSTRUCTION : RESOLVE_INSTRUCTION;
  };

  /**
   * Write back the status and round the steps imply.
   *
   * The status column is a cache of what planState computes; every mutating tool refreshes
   * it inside the same transaction that appended the step, so a peer polling from the other
   * process sees the two agree.
   */
  function sync(council) {
    const all = steps(council.goal_id);
    const state = planState(all, council.max_rounds);
    const wanted = state.status ?? "active";
    if (council.status !== wanted) {
      setPlanStatus(db(), council.goal_id, wanted, state.reason ?? null);
    }
    if (council.round !== state.round) setPlanRound(db(), council.goal_id, state.round);
    return state;
  }

  const joined = (goalId) => getPlanParticipants(db(), goalId).map((p) => p.agent);

  /**
   * When this council last showed a sign of life.
   *
   * Not `started_at`. A council opened in one session and picked up in the next is old by
   * the clock and brand new by the work: the second real run rejoined a council created 32
   * minutes earlier, measured the wait from its creation, and failed on the very first
   * await without waiting at all — then reported a five-minute wait that never happened.
   *
   * A join is a sign of life, so re-triggering the skill restarts the clock, which is what
   * the user means by re-triggering it.
   */
  function lastActivityAt(council, all) {
    const times = [new Date(council.started_at).getTime()];
    for (const p of getPlanParticipants(db(), council.goal_id)) {
      times.push(new Date(p.joined_at).getTime());
    }
    if (all.length) times.push(new Date(all.at(-1).created_at).getTime());
    return Math.max(...times);
  }

  /**
   * The plan's current length, and what this council has done to it.
   *
   * `plan_lines_added_total` is measured from the size recorded at the very first step, so
   * it is the growth this council caused rather than the file's whole history.
   */
  function planSize(council, all) {
    const current = planStats(council.plan_path).plan_lines;
    if (current === null) return { plan_lines: null };

    const sized = all.filter((s) => s.plan_lines != null);
    return {
      plan_lines: current,
      plan_lines_added_last_step:
        sized.length >= 2 ? sized.at(-1).plan_lines - sized.at(-2).plan_lines : null,
      plan_lines_added_total: sized.length ? current - sized[0].plan_lines : null,
    };
  }

  function view(council, agent) {
    const all = steps(council.goal_id);
    const state = planState(all, council.max_rounds);
    const critique = [...all].reverse().find((s) => s.kind === "critique") ?? null;
    const resolution = [...all].reverse().find((s) => s.kind === "resolve") ?? null;
    const here = joined(council.goal_id);

    return {
      goal_id: council.goal_id,
      plan_path: council.plan_path,
      project_path: council.project_path,
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
      // Whether the peer is in the room at all. "Still working" and "never triggered" look
      // identical without this, and the difference decides whether waiting is worthwhile.
      peer_joined: here.includes(agent === AUTHOR ? CRITIC : AUTHOR),
      phase: state.phase,
      next_actor: state.actor ?? null,
      critiques_so_far: all.filter((s) => s.kind === "critique").length,
      // How big the plan is, and how much this loop has added to it. Nothing here ever
      // removes anything, so without a number in front of both models the plan grows into a
      // specification and nobody notices until it is finished.
      ...planSize(council, all),
      latest_critique: critique
        ? {
            round: critique.round,
            critique: critique.critique,
            blockers: critique.blockers,
            highs: critique.highs,
            mediums: critique.mediums,
            lows: critique.lows,
            readiness: critique.critic_readiness,
          }
        : null,
      latest_resolution: resolution
        ? {
            round: resolution.round,
            applied: resolution.applied,
            rejected: resolution.rejected,
            additional: resolution.additional,
            deferred: resolution.deferred,
            needs_user_decision: resolution.needs_user,
            readiness: resolution.author_readiness,
          }
        : null,
    };
  }

  /** What to tell an agent whose turn it is not, or whose council has stopped. */
  function nextStep(council, agent, state) {
    if (state.phase === "final") {
      return council.status === "ready"
        ? "The critic reports the plan is implementation-ready. Call plan_council_close and " +
            "tell the user the plan is ready to implement."
        : "The council has stopped. Call plan_council_close and show the user why.";
    }
    if (state.phase === "user") {
      return (
        "Stop and hand back to the user: the decision in latest_resolution.needs_user_decision " +
        "is theirs to make, not yours to guess. When they answer, call plan_council_resume."
      );
    }
    if (state.actor === agent) {
      return state.phase === "critique"
        ? `Critique the plan for round ${state.round} with plan_council_critique.`
        : `Resolve round ${state.round}'s critique with plan_council_resolve.`;
    }
    return (
      `Waiting on ${state.actor} to ${state.phase}. Call plan_council_await, and keep ` +
      "calling it while it answers retry:true — the server ends the wait itself. " +
      (joined(council.goal_id).includes(state.actor)
        ? `${state.actor} has joined and is working; a real critique against a codebase ` +
          "takes many minutes."
        : `${state.actor} has not joined yet — tell the user to run the skill in that window.`)
    );
  }

  const reply = (council, agent, extra = {}) => {
    const all = steps(council.goal_id);
    const state = planState(all, council.max_rounds);
    return ok({
      ok: true,
      ...view(council, agent),
      next_step: nextStep(council, agent, state),
      ...(state.actor === agent ? { instruction: instructionFor(state, all) } : {}),
      ...extra,
    });
  };

  // -------------------------------------------------------------------------
  // plan_council_open
  // -------------------------------------------------------------------------

  server.registerTool(
    "plan_council_open",
    {
      title: "Open or join a plan council",
      description:
        "Start the critique/resolve loop on an implementation plan, or join the one the " +
        "peer already started. Call this first. codex critiques with its critique-plan " +
        "skill; claude applies with plan-critique-resolver, editing the plan file in place.",
      inputSchema: {
        agent: z.enum(AGENTS).describe("Which model you are."),
        plan_path: z
          .string()
          .optional()
          .describe("Absolute path of the plan file. Required when starting."),
        project_path: z
          .string()
          .optional()
          .describe(
            "Absolute path of the project. Required when starting. Pass it explicitly — " +
              "the server's working directory does not identify the project.",
          ),
        git_branch: z.string().optional(),
        max_rounds: z.number().int().min(1).max(20).optional().describe("Default 10."),
        fresh: z
          .boolean()
          .optional()
          .describe(
            "Abandon any council already running on this plan and start again at round 1. " +
              "Only pass this when the user has said so — it discards a critique the peer " +
              "may already have spent real work on.",
          ),
      },
    },
    async ({ agent, plan_path, project_path, git_branch, max_rounds = 10, fresh = false }) => {
      try {
        // Starting a run clears what a dead session left behind, so the user does not have
        // to. Only the author, only when actually starting (a plan_path is given), and only
        // for work that has sat untouched — anything recent might be a peer mid-turn, and a
        // council on this same plan is a resume rather than a leftover.
        const cleared = agent === AUTHOR && plan_path ? sweepForOpen(plan_path, fresh) : [];

        // One council at a time, across both modes. A debate council mid-flight means a
        // peer is blocked waiting on this agent; starting a plan council here would strand
        // it — the deadlock class this project already fixed once.
        const [blocked] = unfinishedElsewhere(db(), agent, "plan_council");
        if (blocked) {
          return fail(
            `you have an unfinished ${blocked.mode.label}: ${blocked.brief.goal_id} ` +
              `(${blocked.brief.status}). Finish it, or release it with council_abandon, ` +
              "before starting a plan council. Closing does not release anything — it only " +
              "renders the record — so calling it here will leave you blocked.",
            {
              blocking_goal_id: blocked.brief.goal_id,
              blocking_mode: blocked.mode.name,
              release_with: "council_abandon",
            },
          );
        }

        const council = transact(db(), () => {
          const existing = getUnfinishedPlanCouncil(db());
          if (existing) {
            joinPlanCouncil(db(), existing.goal_id, agent);
            return existing;
          }

          // Only the author starts one. The plan is theirs, and they are the only side that
          // knows which file is under review.
          //
          // On the second real run the critic found no open council, listed the plans
          // directory, picked a file itself and opened a second council on its guess. It
          // guessed right that time. A critic reviewing a plan nobody asked about is worse
          // than a critic that waits.
          if (agent !== AUTHOR) {
            throw new Error(
              `${AUTHOR} starts a plan council, because the plan is theirs — do not guess at ` +
                "a plan file or open one yourself. No council is open yet: tell the user to " +
                `run the skill in the ${AUTHOR} window, then call plan_council_open again.`,
            );
          }

          if (!plan_path) throw new Error("plan_path is required when starting a plan council");
          if (!project_path) {
            throw new Error("project_path is required when starting a plan council");
          }

          const base = (plan_path.split("/").pop() ?? "plan").replace(/\.[^.]+$/, "");
          const id = makeGoalId(
            `plan ${base}`,
            (candidate) =>
              getPlanCouncil(db(), candidate) !== null || getCouncil(db(), candidate) !== null,
          );
          const fresh = createPlanCouncil(db(), {
            goalId: id,
            planPath: plan_path,
            projectPath: project_path,
            gitBranch: git_branch,
            maxRounds: max_rounds,
          });
          joinPlanCouncil(db(), id, agent);
          return fresh;
        });

        writePlanBrief(council);
        log(`plan open: ${council.goal_id} agent=${agent} round=${council.round}`);

        // Asked for one plan, joined a council about another. Silently handing back the
        // running council would have the model critiquing a file nobody mentioned.
        // The author is picking up work that already exists. That is their decision to
        // make, not the model's: resuming silently confuses, and starting over silently
        // throws away a critique the peer may have spent real work on.
        const offer = agent === AUTHOR && !fresh ? resumeOffer(council) : null;

        const wrongPlan = plan_path && plan_path !== council.plan_path;
        return reply(council, agent, {
          ...(cleared.length ? { cleared } : {}),
          ...(offer
            ? {
                resuming: offer,
                // Suppressed on purpose: "run the resolver" and "stop and ask" are
                // contradictory orders, and the model would follow the concrete one.
                instruction: undefined,
                next_step:
                  "Stop. Do not resolve or critique anything yet. Show the user what is in " +
                  "`resuming` — the round, how old it is, what the waiting critique found, " +
                  "and whether the plan file changed since — then ask whether to resume or " +
                  "start over. Start over means calling plan_council_open again with " +
                  "fresh:true, which discards this council." +
                  (offer.plan_changed_since_critique === true
                    ? " The plan file HAS changed since that critique was written, so parts " +
                      "of it may object to text that no longer exists. Say so first."
                    : ""),
              }
            : {}),
          ...(wrongPlan
            ? {
                warning:
                  `you asked for ${plan_path}, but the running plan council is about ` +
                  `${council.plan_path}. Finish or abandon that one before reviewing another ` +
                  "plan — tell the user rather than critiquing the wrong file.",
              }
            : {}),
        });
      } catch (error) {
        return fail(error.message);
      }
    },
  );

  // -------------------------------------------------------------------------
  // plan_council_critique
  // -------------------------------------------------------------------------

  server.registerTool(
    "plan_council_critique",
    {
      title: "Submit a critique of the plan",
      description:
        "Record the output of your critique-plan skill for this round. Only the critic may " +
        "call this. The counts are what let the server stop the loop: from round 3 only " +
        "Blocker and High findings hold the plan back.",
      inputSchema: {
        goal_id: z.string(),
        agent: z.enum(AGENTS),
        critique: z
          .string()
          .max(LIMITS_PLAN.critique)
          .describe("The Needs Fix findings in full, as the skill wrote them. Markdown."),
        blockers: z.number().int().min(0).describe("How many Blocker findings."),
        highs: z.number().int().min(0).describe("How many High findings."),
        mediums: z.number().int().min(0).describe("How many Medium findings."),
        lows: z.number().int().min(0).describe("How many Low findings."),
        readiness: z
          .enum(CRITIC_READINESS)
          .describe("The skill's Readiness line. Ready ends the council."),
      },
    },
    async ({ goal_id, agent, ...fields }) => {
      try {
        const result = transact(db(), () => {
          const council = requireOpen(goal_id);
          const state = stateOf(council);

          if (agent !== CRITIC) {
            throw new Error(`${CRITIC} critiques this council; you are the author`);
          }
          if (state.phase !== "critique") {
            throw new Error(
              state.phase === "resolve"
                ? `nothing to critique: ${AUTHOR} still owes the resolution for round ${state.round}`
                : `the council has stopped — ${state.reason}`,
            );
          }

          const seq = appendPlanStep(db(), goal_id, {
            ...validateCritique(fields, council, state.round),
            ...planStats(council.plan_path),
          });
          sync(council);
          return { seq, round: state.round };
        });

        const council = getPlanCouncil(db(), goal_id);
        writePlanStep(goal_id, steps(goal_id).find((s) => s.seq === result.seq));
        log(`plan critique: ${goal_id} round=${result.round} status=${council.status}`);

        return reply(council, agent);
      } catch (error) {
        return fail(error.message, { field: error.field ?? null });
      }
    },
  );

  // -------------------------------------------------------------------------
  // plan_council_resolve
  // -------------------------------------------------------------------------

  server.registerTool(
    "plan_council_resolve",
    {
      title: "Record how you resolved the critique",
      description:
        "Record the output of your plan-critique-resolver skill. Only the author may call " +
        "this. The skill edits the plan file itself — this records what it did. An entry " +
        "in needs_user_decision stops the council and hands that decision to the user.",
      inputSchema: {
        goal_id: z.string(),
        agent: z.enum(AGENTS),
        applied: z
          .string()
          .max(LIMITS_PLAN.block)
          .describe("Plan Fixes Applied — what changed in the plan file, and why."),
        rejected: z
          .string()
          .max(LIMITS_PLAN.block)
          .optional()
          .describe("Critiques Rejected, with the reason for each. 'None.' if there were none."),
        additional: z
          .string()
          .max(LIMITS_PLAN.block)
          .optional()
          .describe("Additional Issues Integrated. 'None.' if there were none."),
        deferred: z
          .string()
          .max(LIMITS_PLAN.block)
          .optional()
          .describe(
            "Medium and Low findings left unapplied, by name. Required from round 3 when " +
              "the critique carried any, because from there they no longer hold the plan " +
              "back. Name any you applied anyway, and why it was worth the length.",
          ),
        needs_user_decision: z
          .string()
          .max(LIMITS_PLAN.block)
          .optional()
          .describe(
            "Needs User Decision — unresolved choices that are the user's. Anything here " +
              "stops the council. 'None.' if there were none.",
          ),
        readiness: z
          .enum(AUTHOR_READINESS)
          .describe("The skill's Implementation-Ready Decision."),
      },
    },
    async ({ goal_id, agent, ...fields }) => {
      try {
        const result = transact(db(), () => {
          const council = requireOpen(goal_id);
          const state = stateOf(council);

          if (agent !== AUTHOR) {
            throw new Error(`${AUTHOR} resolves this council; you are the critic`);
          }
          if (state.phase !== "resolve") {
            throw new Error(
              state.phase === "critique"
                ? `nothing to resolve: waiting on ${CRITIC} to critique round ${state.round}`
                : `the council has stopped — ${state.reason}`,
            );
          }

          // The critique being answered, so the severity counts can be held against this
          // resolve. It is this round's, not the latest: a decision hands the same round
          // back to the author, who resolves again against the critique already on record.
          const answering =
            [...steps(goal_id)]
              .reverse()
              .find((s) => s.kind === "critique" && s.round === state.round) ?? null;

          const seq = appendPlanStep(db(), goal_id, {
            ...validateResolve(fields, state.round, answering),
            ...planStats(council.plan_path),
          });
          sync(council);
          return { seq, round: state.round };
        });

        const council = getPlanCouncil(db(), goal_id);
        writePlanStep(goal_id, steps(goal_id).find((s) => s.seq === result.seq));
        log(`plan resolve: ${goal_id} round=${result.round} status=${council.status}`);

        return reply(council, agent);
      } catch (error) {
        return fail(error.message, { field: error.field ?? null });
      }
    },
  );

  // -------------------------------------------------------------------------
  // plan_council_await
  // -------------------------------------------------------------------------

  server.registerTool(
    "plan_council_await",
    {
      title: "Wait for your turn",
      description:
        "Block until it is your move, or until the council stops. If the reply has " +
        "retry:true, call it again. Returns the peer's latest critique or resolution.",
      inputSchema: {
        goal_id: z.string(),
        agent: z.enum(AGENTS),
      },
    },
    async ({ goal_id, agent }) => {
      try {
        const opened = getPlanCouncil(db(), goal_id);
        if (!opened) return fail(`no plan council with goal_id ${goal_id}`);

        const deadline = Date.now() + pollBudgetMs;
        while (Date.now() < deadline) {
          const council = getPlanCouncil(db(), goal_id);

          if (TERMINAL.includes(council.status)) {
            return reply(council, agent, {
              arrived: council.status === "ready" || council.status === "capped",
              retry: false,
              note: `the council is ${council.status}; stop waiting`,
            });
          }

          const all = steps(goal_id);
          const state = planState(all, council.max_rounds);

          // Parked on the user. Release immediately — and do not let the stall timer run,
          // or the council dies as `error` while the user is thinking about the very
          // question it asked them.
          if (state.phase === "user") {
            return reply(council, agent, {
              arrived: false,
              retry: false,
              note: "waiting on the user to decide, not on the peer. Show them the decision.",
            });
          }

          if (state.actor === agent) {
            return reply(council, agent, { arrived: true, retry: false });
          }

          // Two different waits, because "nobody is coming yet" and "somebody joined and
          // went quiet" are different situations with different right answers.
          //
          // A step here is a research task — reading a plan against a whole codebase — not
          // a submission. Timing it out on the debate mode's five minutes would kill a
          // healthy council mid-critique and throw away work already done.
          const peerHere = joined(goal_id).includes(state.actor);
          const budget = peerHere ? stepWaitMs : joinWaitMs;
          const since = lastActivityAt(council, all);
          const waited = Date.now() - since;

          if (waited > budget) {
            const minutes = Math.max(1, Math.round(waited / 60_000));

            // A peer that has not been triggered yet is a not-yet, not a failure. Killing
            // the council here destroys good work and forces a fresh start: on the second
            // real run it errored a council the user was about to complete, and the critic
            // then invented a second one. Hand back to the user and leave this one open.
            if (!peerHere) {
              return reply(council, agent, {
                arrived: false,
                retry: false,
                waited_minutes: minutes,
                note:
                  `${state.actor} has not joined after ${minutes} minutes. Stop waiting and ` +
                  "tell the user to run the skill in that window — this council stays open, " +
                  "so call plan_council_await again once they have. Use council_abandon only " +
                  "if they want to drop it.",
              });
            }

            transact(db(), () =>
              setPlanStatus(
                db(),
                goal_id,
                "error",
                `${state.actor} joined but did not ${state.phase} round ${state.round} ` +
                  `within ${minutes} minutes`,
              ),
            );
            return reply(getPlanCouncil(db(), goal_id), agent, {
              arrived: false,
              retry: false,
              note:
                `${state.actor} stopped responding. The plan file keeps every fix applied ` +
                "so far; the trail is still readable.",
            });
          }

          await sleep(pollIntervalMs);
        }

        const council = getPlanCouncil(db(), goal_id);
        const state = stateOf(council);
        const peerHere = joined(goal_id).includes(state.actor);
        const all = steps(goal_id);
        const since = lastActivityAt(council, all);
        const left = Math.max(0, (peerHere ? stepWaitMs : joinWaitMs) - (Date.now() - since));

        return reply(council, agent, {
          arrived: false,
          retry: true,
          waited_seconds: Math.round(pollBudgetMs / 1000),
          minutes_left: Math.round(left / 60_000),
          // Say this every time. Deciding for yourself that the peer is absent, after a
          // couple of polls, is how the first real run ended: the author gave up at 2.5
          // minutes and told the user Codex had not joined, while Codex was mid-critique.
          note:
            `Waiting on ${state.actor} to ${state.phase}. Call plan_council_await again — ` +
            "keep calling while it answers retry:true. The server ends the wait itself; do " +
            "not decide the peer is absent. " +
            (peerHere
              ? `${state.actor} has joined and is working.`
              : `${state.actor} has not joined — tell the user to run the skill in that window.`),
        });
      } catch (error) {
        return fail(error.message);
      }
    },
  );

  // -------------------------------------------------------------------------
  // plan_council_resume
  // -------------------------------------------------------------------------

  server.registerTool(
    "plan_council_resume",
    {
      title: "Give the council the user's decision",
      description:
        "Record what the user decided about the point the resolver could not settle, and " +
        "hand the loop back to the author. The round does not advance — no new critique " +
        "was raised. Either side may call this; the user is in one window.",
      inputSchema: {
        agent: z.enum(AGENTS),
        decision: z
          .string()
          .max(LIMITS_PLAN.decision)
          .describe("What the user decided, in their terms. Recorded in the trail."),
        goal_id: z.string().optional().describe("Defaults to the parked council."),
      },
    },
    async ({ agent, decision, goal_id }) => {
      try {
        const result = transact(db(), () => {
          const council = goal_id
            ? getPlanCouncil(db(), goal_id)
            : getUnfinishedPlanCouncil(db());
          if (!council) {
            throw new Error(
              goal_id ? `no plan council with goal_id ${goal_id}` : "no plan council to resume",
            );
          }
          if (council.status !== "needs_user") {
            throw new Error(
              `this council is ${council.status}, not waiting on a decision. ` +
                "Nothing to resume.",
            );
          }

          const state = stateOf(council);
          const seq = appendPlanStep(db(), council.goal_id, {
            kind: "decision",
            actor: "user",
            round: state.round,
            decision: validateDecision(decision),
          });
          sync(council);
          return { goalId: council.goal_id, seq };
        });

        const council = getPlanCouncil(db(), result.goalId);
        writePlanStep(result.goalId, steps(result.goalId).find((s) => s.seq === result.seq));
        log(`plan resume: ${result.goalId} relayed by=${agent}`);

        return reply(council, agent);
      } catch (error) {
        return fail(error.message, { field: error.field ?? null });
      }
    },
  );

  // -------------------------------------------------------------------------
  // plan_council_close
  // -------------------------------------------------------------------------

  server.registerTool(
    "plan_council_close",
    {
      title: "Render the trail",
      description:
        "Write trail.md and return the summary to show the user. Safe to call twice, and " +
        "safe on a council still running — it renders what exists.",
      inputSchema: {
        agent: z.enum(AGENTS),
        goal_id: z.string().optional(),
      },
    },
    async ({ agent, goal_id }) => {
      try {
        const council = goal_id
          ? getPlanCouncil(db(), goal_id)
          : (getUnfinishedPlanCouncil(db()) ?? getLatestPlanCouncil(db()));
        if (!council) {
          return fail(goal_id ? `no plan council with goal_id ${goal_id}` : "no plan council");
        }

        const all = steps(council.goal_id);
        const path = writePlanTrail(council, all);
        log(`plan close: ${council.goal_id} status=${council.status} steps=${all.length}`);

        return reply(council, agent, {
          trail_path: path,
          summary: planSummaryBlock(council, all),
        });
      } catch (error) {
        return fail(error.message);
      }
    },
  );

  /**
   * What an author is being asked to resume, when there is real work at stake.
   *
   * Only built when steps exist — a council with nothing in it has nothing to lose, so
   * asking about it is noise. Returns null otherwise.
   */
  function resumeOffer(council) {
    const all = steps(council.goal_id);
    if (!all.length) return null;

    const state = planState(all, council.max_rounds);
    const critique = [...all].reverse().find((s) => s.kind === "critique") ?? null;
    const last = all.at(-1);
    const current = planStats(council.plan_path).plan_digest;

    return {
      round: state.round,
      phase: state.phase,
      next_actor: state.actor ?? null,
      minutes_old: Math.round((Date.now() - new Date(last.created_at).getTime()) / 60_000),
      waiting_critique: critique
        ? `${critique.blockers} Blocker, ${critique.highs} High, ${critique.mediums} ` +
          `Medium, ${critique.lows} Low — ${critique.critic_readiness}`
        : null,
      // Null on either side means the check could not run, which is not the same as
      // "unchanged" and must not be reported as it.
      plan_changed_since_critique:
        critique?.plan_digest && current ? critique.plan_digest !== current : null,
    };
  }

  /**
   * Clear what a dead session left behind, and report it.
   *
   * A plan council about the *same* plan is never swept, however old: that is the user
   * resuming work, and abandoning it would throw away rounds already spent. Everything else
   * has to have sat untouched past the stale threshold, so a peer taking its time in the
   * other window is never mistaken for a leftover.
   */
  /**
   * Clear what a dead session left behind, and report it.
   *
   * A council on the *same* plan is never swept, however old: that is the user resuming, and
   * abandoning it would throw away rounds already spent. `force` is the user saying start
   * over, and is the only thing that overrides it.
   */
  function sweepForOpen(planPath, force = false) {
    return sweepStale(db(), force ? -1 : staleAfterMs, {
      agent: AUTHOR,
      protect: (mode, council) =>
        !force && mode.name === "plan_council" && council.plan_path === planPath,
    });
  }

  function requireOpen(goalId) {
    const council = getPlanCouncil(db(), goalId);
    if (!council) throw new Error(`no plan council with goal_id ${goalId}`);
    if (council.status === "aborted") throw new Error("this council was abandoned");
    if (council.status === "error") throw new Error(`this council failed — ${council.stop_reason}`);
    if (council.status === "needs_user") {
      throw new Error(
        "this council is waiting on a decision from the user. Relay it with " +
          "plan_council_resume before going on.",
      );
    }
    return council;
  }
}
