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
  createCouncil,
  joinCouncil,
  getParticipants,
  insertEntry,
  getEntry,
  getEntriesForRound,
  getAllEntries,
  setStatus,
  advanceRound,
  VERDICTS,
  CONFIDENCES,
} from "./db.js";
import { validateSubmission, evaluateStopRules, roundInstruction, LIMITS } from "./rules.js";
import {
  databasePath,
  writeBrief,
  writeEntry,
  revealRound1,
  writeVerdict,
  summaryBlock,
  makeGoalId,
  councilDir,
} from "./render.js";

const AGENTS = ["claude", "codex"];

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

const server = new McpServer(
  { name: "council", version: "0.2.0" },
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
      const result = transact(db(), () => {
        // Joining a named council.
        if (goal_id) {
          const council = getCouncil(db(), goal_id);
          if (!council) throw new Error(`no council with goal_id ${goal_id}`);
          joinCouncil(db(), goal_id, agent, null);
          return council;
        }

        // Already in one? Return it rather than starting a second.
        const mine = getActiveCouncilForAgent(db(), agent);
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
      log(`open: ${result.goal_id} agent=${agent} round=${result.round}`);

      return ok({
        ok: true,
        ...councilView(result),
        question: result.question,
        project_path: result.project_path,
        participants,
        waiting_for_peer: !participants.includes(peerOf(agent)),
        instruction: roundInstruction(result, result.round),
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
          ? "The council has stopped. Call council_close for the verdict."
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
      if (!council) return fail(goal_id ? `no council with goal_id ${goal_id}` : "no active council");

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
      const path = writeVerdict(council, all, null);
      log(`close: ${council.goal_id} status=${council.status}`);

      return ok({
        ok: true,
        ...councilView(council),
        verdict_path: path,
        summary: summaryBlock(council, all, null),
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

const transport = new StdioServerTransport();
await server.connect(transport);
log(`ready, pid ${process.pid}, db ${databasePath()}`);
