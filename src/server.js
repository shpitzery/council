#!/usr/bin/env node
// council — MCP server.
//
// Two of these run at once, one per client. Nothing is cached in process memory; SQLite
// is the source of truth and every invariant holds inside a transaction.
//
// stdout carries the MCP protocol. Nothing may be written to it but protocol frames.
// All diagnostics go to stderr.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  openDatabase,
  transact,
  getCouncil,
  getActiveCouncilForAgent,
  getConcludedCouncilsForAgent,
  createCouncil,
  joinCouncil,
  getParticipants,
  insertEntry,
  getEntry,
  getEntriesForRound,
  getEntriesForAgent,
  getAllEntries,
  setStatus,
  advanceRound,
  getDrafter,
  getDrafts,
  getLatestDraft,
  insertDraft,
  reviewDraft,
  getPlanCouncil,
  getUnfinishedPlanCouncil,
  setPlanStatus,
  getPlanSteps,
  VERDICTS,
  CONFIDENCES,
} from "./db.js";
import { registerPlanTools } from "./plan.js";
import { planState } from "./plan-rules.js";
import {
  validateSubmission,
  evaluateStopRules,
  roundInstruction,
  draftState,
  validateDraft,
  validateReview,
  DRAFT_INSTRUCTION,
  REVIEW_INSTRUCTION,
  DRAFT_VERDICTS,
  MAX_REVIEWS,
  LIMITS,
  LIMITS_DRAFT,
} from "./rules.js";
import {
  databasePath,
  writeBrief,
  writeEntry,
  revealRound1,
  writeAnswer,
  writeVerdict,
  summaryBlock,
  makeGoalId,
  councilDir,
} from "./render.js";

const AGENTS = ["claude", "codex"];

// Only a council that reached a conclusion gets an answer drafted. An aborted council was
// killed on purpose, and an errored one lost a participant — neither has a result worth
// writing up, and drafting either would trap an agent the kill switch is meant to release.
const DRAFTABLE = ["converged", "capped"];

// One await call returns within this budget even if the peer has not arrived, so it stays
// well inside any client's tool-call limit. 90s is proven to work in the Codex app.
// The env overrides exist so tests do not have to wait in real time.
const num = (name, fallback) => Number(process.env[name] ?? fallback) || fallback;
const POLL_BUDGET_MS = num("COUNCIL_POLL_BUDGET_MS", 50_000);
const POLL_INTERVAL_MS = num("COUNCIL_POLL_INTERVAL_MS", 1_500);
// Measured from the agent's own submission for this round.
const TOTAL_WAIT_MS = num("COUNCIL_TOTAL_WAIT_MS", 5 * 60_000);

const log = (...args) => console.error("[council]", ...args);

let database = null;
const db = () => (database ??= openDatabase(databasePath()));

const ok = (payload) => ({
  content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
});
const fail = (message, extra = {}) => ({
  isError: true,
  content: [{ type: "text", text: JSON.stringify({ ok: false, error: message, ...extra }, null, 2) }],
});

const peerOf = (agent) => AGENTS.find((a) => a !== agent);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function councilView(council) {
  return {
    goal_id: council.goal_id,
    round: council.round,
    max_rounds: council.max_rounds,
    final_round: council.round >= council.max_rounds,
    status: council.status,
    stop_reason: council.stop_reason ?? null,
    record_path: councilDir(council.goal_id),
  };
}

/**
 * The council this agent still owes work on, if any.
 *
 * "Unfinished" is not the same as "active". A council whose rounds ended still owes an
 * answer, and treating it as done let one agent walk away mid-draft and open a second
 * council — while its peer sat waiting for a review that was never coming. Two agents,
 * two councils, each waiting on the other.
 */
function unfinishedCouncilForAgent(agent) {
  const active = getActiveCouncilForAgent(db(), agent);
  if (active) return active;

  for (const council of getConcludedCouncilsForAgent(db(), agent, DRAFTABLE)) {
    if (draftView(council.goal_id).phase !== "final") return council;
  }
  return null;
}

/**
 * A one-line description of an unfinished plan council, for the rules that have to see
 * across both modes: the one-at-a-time guard, the kill switch, and council_status.
 */
function planCouncilBrief(council) {
  const state = planState(getPlanSteps(db(), council.goal_id), council.max_rounds);
  return {
    goal_id: council.goal_id,
    mode: "plan_council",
    plan_path: council.plan_path,
    status: council.status,
    phase: state.phase,
    next_actor: state.actor ?? null,
    round: state.round,
  };
}

/** Whose move it is in the drafting phase, plus the instruction for that move. */
function draftView(goalId) {
  const drafter = getDrafter(db(), goalId);
  const reviewer = peerOf(drafter);
  const drafts = getDrafts(db(), goalId);
  const state = draftState(drafts, drafter, reviewer);
  const latest = drafts.length ? drafts[drafts.length - 1] : null;

  return {
    drafter,
    reviewer,
    phase: state.phase,
    next_actor: state.actor ?? null,
    revision: state.revision,
    reviews_remaining: Math.max(0, MAX_REVIEWS - drafts.filter((d) => d.verdict).length),
    final_reason: state.reason ?? null,
    latest_draft: latest
      ? {
          revision: latest.revision,
          author: latest.author,
          answer: latest.answer,
          verdict: latest.verdict ?? null,
          revisions: latest.revisions ?? null,
        }
      : null,
  };
}

const server = new McpServer(
  { name: "council", version: "0.3.0" },
  { capabilities: { tools: {} } },
);

// ---------------------------------------------------------------------------
// council_open
// ---------------------------------------------------------------------------

server.registerTool(
  "council_open",
  {
    title: "Open or join a council",
    description:
      "Start a council on a question, or join the one the peer already started. Call this " +
      "first. Returns the goal id and the instruction for the round you are about to answer.",
    inputSchema: {
      agent: z.enum(AGENTS).describe("Which model you are."),
      question: z
        .string()
        .optional()
        .describe("The question to decide. Required when starting; ignored when joining."),
      project_path: z
        .string()
        .optional()
        .describe(
          "Absolute path of the project under discussion. Required when starting. Pass it " +
            "explicitly — the server's working directory does not identify the project.",
        ),
      git_branch: z.string().optional(),
      max_rounds: z.number().int().min(1).max(10).optional().describe("Default 3."),
      goal_id: z.string().optional().describe("Join a specific council rather than the active one."),
    },
  },
  async ({ agent, question, project_path, git_branch, max_rounds = 3, goal_id }) => {
    try {
      // One council at a time holds across both modes, not just this one. A plan council
      // mid-loop means the peer is waiting on a critique or a resolution; starting a debate
      // council here would strand it.
      //
      // This fails rather than returning the plan council the way an unfinished debate
      // council is returned: the two payloads are different shapes, and a plan council
      // handed back from council_open would be read as a debate council to submit into.
      const plan = getUnfinishedPlanCouncil(db());
      if (plan) {
        const brief = planCouncilBrief(plan);
        return fail(
          `a plan council is unfinished: ${brief.goal_id} (${brief.status}, ` +
            `${brief.phase} owed by ${brief.next_actor ?? "the user"}). Finish it with ` +
            "plan_council_open, or release it with council_abandon, before starting a council.",
          { blocking: brief },
        );
      }

      const result = transact(db(), () => {
        // Joining a named council.
        if (goal_id) {
          const council = getCouncil(db(), goal_id);
          if (!council) throw new Error(`no council with goal_id ${goal_id}`);
          joinCouncil(db(), goal_id, agent, null);
          return council;
        }

        // Already owe work on one? Return it rather than starting a second. This covers
        // the drafting phase, not just the rounds — an unwritten answer is unfinished work.
        const mine = unfinishedCouncilForAgent(agent);
        if (mine) return mine;

        // The peer may have opened one already. Join it.
        const peers = getActiveCouncilForAgent(db(), peerOf(agent));
        if (peers) {
          joinCouncil(db(), peers.goal_id, agent, null);
          return peers;
        }

        // Nothing to join, so start one.
        if (!question) throw new Error("question is required when starting a new council");
        if (!project_path) throw new Error("project_path is required when starting a new council");

        const id = makeGoalId(question, (candidate) => getCouncil(db(), candidate) !== null);
        const council = createCouncil(db(), {
          goalId: id,
          question,
          projectPath: project_path,
          gitBranch: git_branch,
          maxRounds: max_rounds,
        });
        joinCouncil(db(), id, agent, null);
        return council;
      });

      writeBrief(result);
      const participants = getParticipants(db(), result.goal_id).map((p) => p.agent);

      // What this agent has already said. A session that lost its context, or a second
      // session joining the same council, otherwise has no way to know it already
      // answered — it re-submits, and the failure surfaces as a confusing complaint about
      // a different field entirely.
      const mine = getEntriesForAgent(db(), result.goal_id, agent);
      const myLastRound = mine.length ? Math.max(...mine.map((e) => e.round)) : 0;
      const owesThisRound = myLastRound < result.round;

      // The rounds may be over while the answer is not. Say so, or the agent reads
      // "converged" as "done" and wanders off to open another council.
      const drafting =
        DRAFTABLE.includes(result.status) && draftView(result.goal_id).phase !== "final"
          ? draftView(result.goal_id)
          : null;

      log(
        `open: ${result.goal_id} agent=${agent} round=${result.round} ` +
          `already_submitted=${myLastRound}`,
      );

      return ok({
        ok: true,
        ...councilView(result),
        question: result.question,
        project_path: result.project_path,
        participants,
        waiting_for_peer: !participants.includes(peerOf(agent)),
        your_submitted_rounds: mine.map((e) => e.round),
        your_last_position: mine.length ? mine[mine.length - 1].position : null,
        ...(drafting ? draftView(result.goal_id) : {}),
        next_step: drafting
          ? drafting.next_actor === agent
            ? `The rounds are over. You owe the ${drafting.phase} — ` +
              `call council_${drafting.phase === "draft" ? "draft" : "review"}.`
            : `The rounds are over and the answer is unfinished. Waiting on ` +
              `${drafting.next_actor} to ${drafting.phase} — call council_await_peer.`
          : owesThisRound
            ? `Submit your answer for round ${result.round}.`
            : `You have already submitted round ${myLastRound}. Do not submit it again — ` +
              "call council_await_peer to read the peer's answer for that round.",
        instruction: drafting
          ? drafting.next_actor === agent
            ? drafting.phase === "draft"
              ? DRAFT_INSTRUCTION
              : REVIEW_INSTRUCTION
            : "Do not start another council. This one still owes an answer."
          : owesThisRound
            ? roundInstruction(result, result.round)
            : "Read your own last position above before continuing, so you do not contradict " +
              "or disown what you already argued.",
      });
    } catch (error) {
      return fail(error.message);
    }
  },
);

// ---------------------------------------------------------------------------
// council_submit
// ---------------------------------------------------------------------------

server.registerTool(
  "council_submit",
  {
    title: "Submit your answer for the current round",
    description:
      "Record your position for the round in progress. The round number is taken from the " +
      "council, not from you. A submission that breaks the rules is rejected, not stored — " +
      "read the error, fix the field it names, and call again.",
    inputSchema: {
      goal_id: z.string(),
      agent: z.enum(AGENTS),
      position: z
        .string()
        .max(LIMITS.position)
        .describe("One sentence: what you think should be done."),
      reasoning: z
        .array(z.string())
        .min(1)
        .max(LIMITS.reasoning)
        .describe("Why, in at most 4 bullets."),
      evidence: z
        .array(z.string())
        .min(1)
        .max(LIMITS.evidence)
        .describe(
          "What backs this up: file:line, command output, test result, or a document " +
            "quote. Opinion is not evidence.",
        ),
      verdict_on_peer: z
        .enum(VERDICTS)
        .optional()
        .describe("Omit on round 1. Required afterwards."),
      disagreement: z
        .string()
        .optional()
        .describe("Required with DISAGREE. Quote the exact line you contest."),
      settling_test: z
        .string()
        .optional()
        .describe("Required with UNRESOLVED. The concrete check that would decide it."),
      new_arguments: z.boolean().describe("Did this entry add anything not already said?"),
      confidence: z.enum(CONFIDENCES),
    },
  },
  async ({ goal_id, agent, ...fields }) => {
    try {
      const outcome = transact(db(), () => {
        const council = getCouncil(db(), goal_id);
        const participants = getParticipants(db(), goal_id).map((p) => p.agent);

        const clean = validateSubmission(
          { agent, round: council?.round, ...fields },
          council,
          participants.includes(agent),
        );

        insertEntry(db(), goal_id, clean);

        const round = council.round;
        const thisRound = getEntriesForRound(db(), goal_id, round);
        const bothIn = participants.length >= 2 && thisRound.length >= participants.length;

        if (!bothIn) {
          return { council, round, bothIn, entries: thisRound, verdict: { stop: false } };
        }

        const all = getAllEntries(db(), goal_id);
        const verdict = evaluateStopRules(council, [], all);

        if (verdict.stop) {
          setStatus(db(), goal_id, verdict.status, verdict.reason);
        } else {
          advanceRound(db(), goal_id, round + 1);
        }

        return { council: getCouncil(db(), goal_id), round, bothIn, entries: thisRound, verdict, all };
      });

      // Disk writes happen after the transaction commits. Round 1 is held back until both
      // sides are in, so there is no early file for a late starter to read.
      if (outcome.bothIn && outcome.round === 1) {
        revealRound1(goal_id, outcome.entries);
      } else if (outcome.round > 1) {
        writeEntry(goal_id, getEntry(db(), goal_id, agent, outcome.round));
      }

      const council = outcome.council;
      log(
        `submit: ${goal_id} agent=${agent} round=${outcome.round} ` +
          `both=${outcome.bothIn} stop=${outcome.verdict.stop}`,
      );

      return ok({
        ok: true,
        ...councilView(council),
        peer_submitted: outcome.bothIn,
        stopped: Boolean(outcome.verdict.stop),
        stop_reason: outcome.verdict.reason ?? null,
        next_step: outcome.verdict.stop
          ? getDrafter(db(), goal_id) === agent
            ? "The rounds are over. You are the drafter — write the answer with council_draft."
            : "The rounds are over. Call council_await_peer to wait for the draft, then review it."
          : "Call council_await_peer to read the peer's answer for this round.",
      });
    } catch (error) {
      return fail(error.message, { field: error.field ?? null });
    }
  },
);

// ---------------------------------------------------------------------------
// council_await_peer
// ---------------------------------------------------------------------------

server.registerTool(
  "council_await_peer",
  {
    title: "Wait for the peer's answer",
    description:
      "Block until the peer submits their answer for the round you just answered, then " +
      "return it. This is the only way to read the peer on round 1 — that is what keeps " +
      "the first answers independent. If it returns retry:true, call it again.",
    inputSchema: {
      goal_id: z.string(),
      agent: z.enum(AGENTS),
    },
  },
  async ({ goal_id, agent }) => {
    try {
      const council = getCouncil(db(), goal_id);
      if (!council) return fail(`no council with goal_id ${goal_id}`);

      // Killed or broken: release immediately. This is what the kill switch depends on.
      if (council.status !== "active" && !DRAFTABLE.includes(council.status)) {
        return ok({
          ok: true,
          arrived: false,
          retry: false,
          ...councilView(council),
          note: `council is ${council.status}; stop waiting`,
        });
      }

      // The rounds are over; this is the drafting phase. Wait until the answer is final
      // or it is this agent's move.
      if (council.status !== "active") {
        // How long the phase has been stalled: since the last draft, or since the review
        // that asked for another one.
        const drafts = getDrafts(db(), goal_id);
        const last = drafts.length ? drafts[drafts.length - 1] : null;
        const stalledSince = last
          ? new Date(last.reviewed_at ?? last.drafted_at).getTime()
          : new Date(council.updated_at).getTime();

        const deadline = Date.now() + POLL_BUDGET_MS;
        while (Date.now() < deadline) {
          const view = draftView(goal_id);

          // The peer has abandoned the drafting phase. Do not discard the work: if a
          // draft exists it becomes the answer, marked as never reviewed. Erroring the
          // council here would throw away a perfectly good draft over a missing reply.
          if (Date.now() - stalledSince > TOTAL_WAIT_MS && view.phase !== "final") {
            if (last) {
              transact(db(), () =>
                db()
                  .prepare(
                    `UPDATE drafts SET verdict = 'UNREVIEWED', reviewer = NULL,
                     reviewed_at = ? WHERE goal_id = ? AND revision = ? AND verdict IS NULL`,
                  )
                  .run(new Date().toISOString(), goal_id, last.revision),
              );
              return ok({
                ok: true,
                arrived: true,
                retry: false,
                ...councilView(council),
                ...draftView(goal_id),
                note:
                  `${view.next_actor} did not respond within 5 minutes. Revision ` +
                  `${last.revision} stands as the answer, unreviewed. Call council_close.`,
              });
            }
            transact(db(), () =>
              setStatus(db(), goal_id, "error", `${view.next_actor} never drafted an answer`),
            );
            return ok({
              ok: true,
              arrived: false,
              retry: false,
              ...councilView(getCouncil(db(), goal_id)),
              note: `${view.next_actor} never drafted. The round record is still readable.`,
            });
          }

          if (view.phase === "final") {
            return ok({
              ok: true,
              arrived: true,
              retry: false,
              ...councilView(council),
              ...view,
              next_step: "The answer is final. Call council_close and show it to the user.",
            });
          }

          if (view.next_actor === agent) {
            return ok({
              ok: true,
              arrived: true,
              retry: false,
              ...councilView(council),
              ...view,
              instruction: view.phase === "draft" ? DRAFT_INSTRUCTION : REVIEW_INSTRUCTION,
              next_step:
                view.phase === "draft"
                  ? `Write revision ${view.revision} with council_draft.`
                  : `Review revision ${view.revision} with council_review.`,
            });
          }

          await sleep(POLL_INTERVAL_MS);
        }

        return ok({
          ok: true,
          arrived: false,
          retry: true,
          ...draftView(goal_id),
          note: `waiting on ${draftView(goal_id).next_actor}. Call council_await_peer again.`,
        });
      }

      const mine = getAllEntries(db(), goal_id).filter((e) => e.agent === agent);
      if (mine.length === 0) {
        return fail("submit your own answer before waiting for the peer");
      }
      const round = Math.max(...mine.map((e) => e.round));
      const submittedAt = new Date(mine.find((e) => e.round === round).submitted_at).getTime();
      const peer = peerOf(agent);

      const deadline = Date.now() + POLL_BUDGET_MS;
      while (Date.now() < deadline) {
        const current = getCouncil(db(), goal_id);
        if (current.status !== "active") {
          return ok({
            ok: true,
            arrived: false,
            retry: false,
            ...councilView(current),
            note: `council is ${current.status}; stop waiting`,
          });
        }

        const entry = getEntry(db(), goal_id, peer, round);
        if (entry) {
          const fresh = getCouncil(db(), goal_id);
          return ok({
            ok: true,
            arrived: true,
            ...councilView(fresh),
            peer_entry: entry,
            instruction:
              fresh.status === "active"
                ? roundInstruction(fresh, fresh.round)
                : "The council has stopped. Call council_close for the verdict.",
          });
        }

        if (Date.now() - submittedAt > TOTAL_WAIT_MS) {
          transact(db(), () =>
            setStatus(db(), goal_id, "error", `peer ${peer} did not answer within 5 minutes`),
          );
          return ok({
            ok: true,
            arrived: false,
            retry: false,
            ...councilView(getCouncil(db(), goal_id)),
            note: `${peer} never answered. The council is marked error; the record is still readable.`,
          });
        }

        await sleep(POLL_INTERVAL_MS);
      }

      return ok({
        ok: true,
        arrived: false,
        retry: true,
        waited_seconds: Math.round(POLL_BUDGET_MS / 1000),
        note: `${peer} has not answered yet. Call council_await_peer again.`,
      });
    } catch (error) {
      return fail(error.message);
    }
  },
);

// ---------------------------------------------------------------------------
// council_draft / council_review — the drafting phase
// ---------------------------------------------------------------------------

server.registerTool(
  "council_draft",
  {
    title: "Draft the answer",
    description:
      "After the council stops, write the answer the user actually asked for — prose, not " +
      "a summary of the debate. Only the drafter may call this. Call it again with a " +
      "revised answer if the reviewer asks for changes.",
    inputSchema: {
      goal_id: z.string(),
      agent: z.enum(AGENTS),
      answer: z
        .string()
        .max(LIMITS_DRAFT.answer)
        .describe("Markdown. The answer itself, what to do first, what is still open."),
    },
  },
  async ({ goal_id, agent, answer }) => {
    try {
      const result = transact(db(), () => {
        const council = getCouncil(db(), goal_id);
        if (!council) throw new Error(`no council with goal_id ${goal_id}`);
        if (council.status === "active") {
          throw new Error("the council is still running; finish the rounds before drafting");
        }
        if (!DRAFTABLE.includes(council.status)) {
          throw new Error(
            `this council is ${council.status}, so there is no conclusion to write up`,
          );
        }

        const view = draftView(goal_id);
        if (agent !== view.drafter) {
          throw new Error(
            `${view.drafter} drafts this council; you are the reviewer. ` +
              "Call council_await_peer to wait for the draft, then council_review.",
          );
        }
        if (view.phase === "final") {
          throw new Error(`the answer is already final — ${view.final_reason}`);
        }
        if (view.phase !== "draft") {
          throw new Error(`nothing to draft: waiting on ${view.reviewer} to review`);
        }

        insertDraft(db(), goal_id, view.revision, agent, validateDraft(answer));
        return { council, revision: view.revision };
      });

      const view = draftView(goal_id);
      log(`draft: ${goal_id} rev=${result.revision} by=${agent}`);

      return ok({
        ok: true,
        ...councilView(result.council),
        ...view,
        next_step: `Call council_await_peer to wait for ${view.reviewer}'s review.`,
      });
    } catch (error) {
      return fail(error.message, { field: error.field ?? null });
    }
  },
);

server.registerTool(
  "council_review",
  {
    title: "Review the drafted answer",
    description:
      "Approve the draft, or ask for specific changes. Only the reviewer may call this. " +
      `The review budget is ${MAX_REVIEWS}; after that the latest draft ships as it stands.`,
    inputSchema: {
      goal_id: z.string(),
      agent: z.enum(AGENTS),
      verdict: z
        .enum(DRAFT_VERDICTS)
        .describe("APPROVE only if you would be content to have written it yourself."),
      revisions: z
        .string()
        .max(LIMITS_DRAFT.revisions)
        .optional()
        .describe("Required with REVISE. Quote what to change and say what it should say."),
    },
  },
  async ({ goal_id, agent, verdict, revisions }) => {
    try {
      const result = transact(db(), () => {
        const council = getCouncil(db(), goal_id);
        if (!council) throw new Error(`no council with goal_id ${goal_id}`);

        const view = draftView(goal_id);
        if (agent !== view.reviewer) {
          throw new Error(`${view.reviewer} reviews this council; you are the drafter`);
        }
        if (view.phase === "final") {
          throw new Error(`the answer is already final — ${view.final_reason}`);
        }
        if (view.phase !== "review") {
          throw new Error("nothing to review yet: no draft has been submitted");
        }

        const clean = validateReview(verdict, revisions);
        const latest = getLatestDraft(db(), goal_id);
        reviewDraft(db(), goal_id, latest.revision, agent, verdict, clean);
        return council;
      });

      const view = draftView(goal_id);
      log(`review: ${goal_id} verdict=${verdict} by=${agent} phase=${view.phase}`);

      return ok({
        ok: true,
        ...councilView(result),
        ...view,
        next_step:
          view.phase === "final"
            ? "The answer is final. Call council_close and show the user the answer."
            : `Call council_await_peer to wait for ${view.drafter}'s revision.`,
      });
    } catch (error) {
      return fail(error.message, { field: error.field ?? null });
    }
  },
);

// ---------------------------------------------------------------------------
// council_abandon — the kill switch
// ---------------------------------------------------------------------------

server.registerTool(
  "council_abandon",
  {
    title: "Abandon a council",
    description:
      "Give up on a council that cannot finish — the peer never joined, the question was " +
      "wrong, or the user changed their mind. The record is kept and stays readable. Use " +
      "this before starting a different council, since an unfinished one blocks new ones. " +
      "This is the kill switch for both modes: plan councils are released the same way.",
    inputSchema: {
      agent: z.enum(AGENTS),
      reason: z.string().max(500).describe("Why. This is recorded."),
      goal_id: z.string().optional().describe("Defaults to your unfinished council, of either mode."),
    },
  },
  async ({ agent, reason, goal_id }) => {
    try {
      // One kill switch for both modes. Two would be one more than anyone will remember
      // while locked out, and being locked out is exactly when this gets called.
      const plan = goal_id ? getPlanCouncil(db(), goal_id) : getUnfinishedPlanCouncil(db());
      if (plan) {
        if (plan.status === "aborted") {
          return ok({ ok: true, ...planCouncilBrief(plan), note: "already abandoned" });
        }
        transact(db(), () =>
          setPlanStatus(db(), plan.goal_id, "aborted", `abandoned by ${agent}: ${reason}`),
        );
        log(`abandon: ${plan.goal_id} (plan council) by=${agent}`);
        return ok({
          ok: true,
          ...planCouncilBrief(getPlanCouncil(db(), plan.goal_id)),
          note:
            "Abandoned. The peer is released on its next call, the trail stays readable, " +
            "and you can now open a new council of either mode.",
        });
      }

      const council = goal_id ? getCouncil(db(), goal_id) : unfinishedCouncilForAgent(agent);
      if (!council) {
        return fail(goal_id ? `no council with goal_id ${goal_id}` : "you have no unfinished council");
      }
      if (council.status === "aborted") {
        return ok({ ok: true, ...councilView(council), note: "already abandoned" });
      }

      transact(db(), () => setStatus(db(), council.goal_id, "aborted", `abandoned by ${agent}: ${reason}`));
      const after = getCouncil(db(), council.goal_id);
      log(`abandon: ${council.goal_id} by=${agent}`);

      return ok({
        ok: true,
        ...councilView(after),
        note:
          "Abandoned. The peer is released on its next call, the record stays readable, " +
          "and you can now open a new council.",
      });
    } catch (error) {
      return fail(error.message);
    }
  },
);

// ---------------------------------------------------------------------------
// council_status
// ---------------------------------------------------------------------------

server.registerTool(
  "council_status",
  {
    title: "Read council state",
    description: "Current round, status, and who has answered. Read-only.",
    inputSchema: {
      agent: z.enum(AGENTS),
      goal_id: z.string().optional().describe("Defaults to your active council."),
    },
  },
  async ({ agent, goal_id }) => {
    try {
      const council = goal_id ? getCouncil(db(), goal_id) : getActiveCouncilForAgent(db(), agent);
      if (!council) {
        // "No active council" is a misleading answer to give an agent that is mid-plan
        // council. Point at the mode that actually holds its work.
        const plan = goal_id ? getPlanCouncil(db(), goal_id) : getUnfinishedPlanCouncil(db());
        if (plan) {
          return ok({
            ok: true,
            ...planCouncilBrief(plan),
            note: "This is a plan council, not a debate council. Call plan_council_open for it.",
          });
        }
        return fail(goal_id ? `no council with goal_id ${goal_id}` : "no active council");
      }

      const all = getAllEntries(db(), council.goal_id);
      return ok({
        ok: true,
        ...councilView(council),
        question: council.question,
        participants: getParticipants(db(), council.goal_id).map((p) => p.agent),
        rounds_submitted: all.map((e) => ({
          agent: e.agent,
          round: e.round,
          verdict_on_peer: e.verdict_on_peer,
        })),
        // Full text of your own entries, so a session that lost context can recover what it
        // argued rather than disown it.
        your_entries: getEntriesForAgent(db(), council.goal_id, agent),
      });
    } catch (error) {
      return fail(error.message);
    }
  },
);

// ---------------------------------------------------------------------------
// council_close
// ---------------------------------------------------------------------------

server.registerTool(
  "council_close",
  {
    title: "Render the verdict",
    description:
      "Write verdict.md and return the summary to show the user. Safe to call twice, and " +
      "safe to call on a council that is still running — it renders what exists.",
    inputSchema: {
      agent: z.enum(AGENTS),
      goal_id: z.string().optional(),
    },
  },
  async ({ agent, goal_id }) => {
    try {
      const council = goal_id ? getCouncil(db(), goal_id) : getActiveCouncilForAgent(db(), agent);
      if (!council) return fail(goal_id ? `no council with goal_id ${goal_id}` : "no active council");

      const all = getAllEntries(db(), council.goal_id);
      const drafts = getDrafts(db(), council.goal_id);
      const path = writeVerdict(council, all, null);
      const answerPath = drafts.length ? writeAnswer(council, drafts) : null;
      const view = council.status === "active" ? null : draftView(council.goal_id);
      log(`close: ${council.goal_id} status=${council.status} drafts=${drafts.length}`);

      const final = drafts.length ? drafts[drafts.length - 1] : null;

      return ok({
        ok: true,
        ...councilView(council),
        verdict_path: path,
        answer_path: answerPath,
        // The answer is the thing to show the user. The summary is the working behind it.
        answer: final && view?.phase === "final" ? final.answer : null,
        answer_status: view?.phase === "final" ? view.final_reason : (view?.phase ?? null),
        summary: summaryBlock(council, all, null),
        next_step:
          view && view.phase !== "final"
            ? `The answer is not finished — waiting on ${view.next_actor} to ${view.phase}.`
            : "Show the user the answer. The summary is the working behind it.",
      });
    } catch (error) {
      return fail(error.message);
    }
  },
);

// ---------------------------------------------------------------------------
// council_ping — diagnostic, kept from Phase 1
// ---------------------------------------------------------------------------

server.registerTool(
  "council_ping",
  {
    title: "Council ping",
    description:
      "Diagnostic. Reports which client is connected and how long the call took. " +
      "delay_seconds measures the client's maximum tool-call duration.",
    inputSchema: {
      delay_seconds: z.number().min(0).max(300).optional(),
    },
  },
  async ({ delay_seconds = 0 }) => {
    const started = Date.now();
    if (delay_seconds > 0) await sleep(delay_seconds * 1000);
    let client = null;
    try {
      client = server.server.getClientVersion() ?? null;
    } catch {
      client = null;
    }
    return ok({
      ok: true,
      marker: "COUNCIL-PING-OK",
      client,
      requested_delay_seconds: delay_seconds,
      elapsed_seconds: Number(((Date.now() - started) / 1000).toFixed(2)),
      server_pid: process.pid,
      database: databasePath(),
      node_version: process.version,
      timestamp: new Date().toISOString(),
    });
  },
);

// ---------------------------------------------------------------------------
// The plan council — a separate mode over the same database, so the one-at-a-time guard
// can see across both. Everything shared is passed in rather than imported.
// ---------------------------------------------------------------------------

registerPlanTools(server, {
  db,
  ok,
  fail,
  sleep,
  log,
  pollBudgetMs: POLL_BUDGET_MS,
  pollIntervalMs: POLL_INTERVAL_MS,
  totalWaitMs: TOTAL_WAIT_MS,
  unfinishedDebateCouncil: unfinishedCouncilForAgent,
});

const transport = new StdioServerTransport();
await server.connect(transport);
log(`ready, pid ${process.pid}, db ${databasePath()}`);
