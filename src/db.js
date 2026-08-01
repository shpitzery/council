// Storage. SQLite is the source of truth.
//
// Two server processes run at once — one per client — so nothing may be cached in
// process memory and every invariant must hold inside a transaction. WAL mode plus a
// busy timeout is what makes concurrent access from two processes safe.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const STATUSES = ["active", "converged", "capped", "error", "aborted"];
export const VERDICTS = ["AGREE", "DISAGREE", "UNRESOLVED"];
export const CONFIDENCES = ["low", "med", "high"];

const PRAGMAS = [
  // WAL lets the two server processes read while the other writes.
  "PRAGMA journal_mode = WAL",
  // Rather than failing instantly when the peer holds the write lock, wait.
  "PRAGMA busy_timeout = 5000",
  "PRAGMA foreign_keys = ON",
];

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS councils (
     goal_id      TEXT PRIMARY KEY,
     question     TEXT NOT NULL,
     project_path TEXT NOT NULL,
     git_branch   TEXT,
     round        INTEGER NOT NULL DEFAULT 1,
     max_rounds   INTEGER NOT NULL DEFAULT 3,
     status       TEXT NOT NULL DEFAULT 'active',
     stop_reason  TEXT,
     started_at   TEXT NOT NULL,
     updated_at   TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS participants (
     goal_id    TEXT NOT NULL REFERENCES councils(goal_id) ON DELETE CASCADE,
     agent      TEXT NOT NULL,
     session_id TEXT,
     joined_at  TEXT NOT NULL,
     PRIMARY KEY (goal_id, agent)
   )`,

  // The composite primary key is the whole defence against double submission.
  // There must be no upsert path around it.
  `CREATE TABLE IF NOT EXISTS entries (
     goal_id         TEXT NOT NULL REFERENCES councils(goal_id) ON DELETE CASCADE,
     agent           TEXT NOT NULL,
     round           INTEGER NOT NULL,
     position        TEXT NOT NULL,
     reasoning       TEXT NOT NULL,
     evidence        TEXT NOT NULL,
     verdict_on_peer TEXT,
     disagreement    TEXT,
     settling_test   TEXT,
     new_arguments   INTEGER NOT NULL,
     confidence      TEXT NOT NULL,
     submitted_at    TEXT NOT NULL,
     PRIMARY KEY (goal_id, agent, round)
   )`,

  // The drafting phase. The round record shows what each side argued; it does not answer
  // the question. One agent drafts the answer, the peer reviews it, bounded by MAX_REVIEWS.
  `CREATE TABLE IF NOT EXISTS drafts (
     goal_id     TEXT NOT NULL REFERENCES councils(goal_id) ON DELETE CASCADE,
     revision    INTEGER NOT NULL,
     author      TEXT NOT NULL,
     answer      TEXT NOT NULL,
     drafted_at  TEXT NOT NULL,
     verdict     TEXT,
     revisions   TEXT,
     reviewer    TEXT,
     reviewed_at TEXT,
     PRIMARY KEY (goal_id, revision)
   )`,

  "CREATE INDEX IF NOT EXISTS entries_by_round ON entries (goal_id, round)",
  "CREATE INDEX IF NOT EXISTS councils_by_status ON councils (status)",
];

export function openDatabase(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  for (const pragma of PRAGMAS) db.prepare(pragma).get();
  for (const statement of SCHEMA) db.prepare(statement).run();
  return db;
}

const now = () => new Date().toISOString();

/** Run fn inside an IMMEDIATE transaction, so the write lock is taken up front. */
export function transact(db, fn) {
  db.prepare("BEGIN IMMEDIATE").run();
  try {
    const result = fn();
    db.prepare("COMMIT").run();
    return result;
  } catch (error) {
    try {
      db.prepare("ROLLBACK").run();
    } catch {
      // A failed rollback must not mask the original error.
    }
    throw error;
  }
}

function inflate(row) {
  if (!row) return null;
  return {
    ...row,
    reasoning: JSON.parse(row.reasoning),
    evidence: JSON.parse(row.evidence),
    new_arguments: Boolean(row.new_arguments),
  };
}

export function getCouncil(db, goalId) {
  return db.prepare("SELECT * FROM councils WHERE goal_id = ?").get(goalId) ?? null;
}

/**
 * The single active council an agent owns. v1 allows only one at a time, which is what
 * lets the stop hook find its council without needing a conversation identifier — the
 * MCP server is not reliably told which conversation is calling it.
 */
export function getActiveCouncilForAgent(db, agent) {
  return (
    db
      .prepare(
        `SELECT c.* FROM councils c
         JOIN participants p ON p.goal_id = c.goal_id
         WHERE p.agent = ? AND c.status = 'active'
         ORDER BY c.started_at DESC
         LIMIT 1`,
      )
      .get(agent) ?? null
  );
}

export function createCouncil(db, { goalId, question, projectPath, gitBranch, maxRounds }) {
  const ts = now();
  db.prepare(
    `INSERT INTO councils
       (goal_id, question, project_path, git_branch, round, max_rounds, status, started_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, 'active', ?, ?)`,
  ).run(goalId, question, projectPath, gitBranch ?? null, maxRounds, ts, ts);
  return getCouncil(db, goalId);
}

export function joinCouncil(db, goalId, agent, sessionId) {
  db.prepare(
    `INSERT INTO participants (goal_id, agent, session_id, joined_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (goal_id, agent) DO UPDATE SET
       session_id = COALESCE(excluded.session_id, participants.session_id)`,
  ).run(goalId, agent, sessionId ?? null, now());
}

export function getParticipants(db, goalId) {
  return db.prepare("SELECT * FROM participants WHERE goal_id = ? ORDER BY agent").all(goalId);
}

/** Called by the stop hook the first time it fires, binding a session to a council. */
export function bindSession(db, goalId, agent, sessionId) {
  db.prepare("UPDATE participants SET session_id = ? WHERE goal_id = ? AND agent = ?").run(
    sessionId,
    goalId,
    agent,
  );
}

export function insertEntry(db, goalId, entry) {
  db.prepare(
    `INSERT INTO entries
       (goal_id, agent, round, position, reasoning, evidence,
        verdict_on_peer, disagreement, settling_test, new_arguments, confidence, submitted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    goalId,
    entry.agent,
    entry.round,
    entry.position,
    JSON.stringify(entry.reasoning),
    JSON.stringify(entry.evidence),
    entry.verdict_on_peer ?? null,
    entry.disagreement ?? null,
    entry.settling_test ?? null,
    entry.new_arguments ? 1 : 0,
    entry.confidence,
    now(),
  );
}

export function getEntry(db, goalId, agent, round) {
  return inflate(
    db
      .prepare("SELECT * FROM entries WHERE goal_id = ? AND agent = ? AND round = ?")
      .get(goalId, agent, round),
  );
}

/**
 * Everything this agent has already submitted.
 *
 * A session that lost its context — or a second session joining the same council — has no
 * other way to learn it has already answered. Without this it re-submits, gets stamped
 * with the current round, and fails validation with a message about the wrong thing.
 */
export function getEntriesForAgent(db, goalId, agent) {
  return db
    .prepare("SELECT * FROM entries WHERE goal_id = ? AND agent = ? ORDER BY round")
    .all(goalId, agent)
    .map(inflate);
}

export function getEntriesForRound(db, goalId, round) {
  return db
    .prepare("SELECT * FROM entries WHERE goal_id = ? AND round = ? ORDER BY agent")
    .all(goalId, round)
    .map(inflate);
}

export function getAllEntries(db, goalId) {
  return db
    .prepare("SELECT * FROM entries WHERE goal_id = ? ORDER BY round, agent")
    .all(goalId)
    .map(inflate);
}

/** The most recent entry each agent has submitted. Used by the stop rules. */
export function getLatestEntries(db, goalId) {
  return db
    .prepare(
      `SELECT e.* FROM entries e
       JOIN (SELECT agent, MAX(round) AS round FROM entries WHERE goal_id = ? GROUP BY agent) m
         ON m.agent = e.agent AND m.round = e.round
       WHERE e.goal_id = ?`,
    )
    .all(goalId, goalId)
    .map(inflate);
}

export function setStatus(db, goalId, status, stopReason = null) {
  if (!STATUSES.includes(status)) throw new Error(`unknown status: ${status}`);
  db.prepare("UPDATE councils SET status = ?, stop_reason = ?, updated_at = ? WHERE goal_id = ?").run(
    status,
    stopReason,
    now(),
    goalId,
  );
}

/** The agent who drafts the answer: whoever joined first. Deterministic, so two idle
 *  models cannot race for the role. */
export function getDrafter(db, goalId) {
  const row = db
    .prepare("SELECT agent FROM participants WHERE goal_id = ? ORDER BY joined_at, agent LIMIT 1")
    .get(goalId);
  return row?.agent ?? null;
}

export function getDrafts(db, goalId) {
  return db.prepare("SELECT * FROM drafts WHERE goal_id = ? ORDER BY revision").all(goalId);
}

export function getLatestDraft(db, goalId) {
  return (
    db.prepare("SELECT * FROM drafts WHERE goal_id = ? ORDER BY revision DESC LIMIT 1").get(goalId) ??
    null
  );
}

export function insertDraft(db, goalId, revision, author, answer) {
  db.prepare(
    "INSERT INTO drafts (goal_id, revision, author, answer, drafted_at) VALUES (?, ?, ?, ?, ?)",
  ).run(goalId, revision, author, answer, now());
}

export function reviewDraft(db, goalId, revision, reviewer, verdict, revisions) {
  db.prepare(
    `UPDATE drafts SET verdict = ?, revisions = ?, reviewer = ?, reviewed_at = ?
     WHERE goal_id = ? AND revision = ? AND verdict IS NULL`,
  ).run(verdict, revisions ?? null, reviewer, now(), goalId, revision);
}

export function advanceRound(db, goalId, round) {
  db.prepare("UPDATE councils SET round = ?, updated_at = ? WHERE goal_id = ?").run(
    round,
    now(),
    goalId,
  );
}
