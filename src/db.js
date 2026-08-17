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
     max_rounds   INTEGER NOT NULL DEFAULT 10,
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

  // The plan council. A separate mode with its own table: it automates the
  // critique-plan / plan-critique-resolver loop, where entries are free text rather than
  // the debate mode's one-sentence position and capped bullet lists. Same database, so
  // the one-at-a-time guard can see across both modes.
  `CREATE TABLE IF NOT EXISTS plan_councils (
     goal_id      TEXT PRIMARY KEY,
     plan_path    TEXT NOT NULL,
     project_path TEXT NOT NULL,
     git_branch   TEXT,
     round        INTEGER NOT NULL DEFAULT 1,
     max_rounds   INTEGER NOT NULL DEFAULT 10,
     status       TEXT NOT NULL DEFAULT 'active',
     stop_reason  TEXT,
     started_at   TEXT NOT NULL,
     updated_at   TEXT NOT NULL
   )`,

  // Who has actually shown up. The roles are fixed, so this is not needed to assign them —
  // it exists so "the peer is still working" can be told apart from "the peer was never
  // triggered". Without it both look identical from the other window, and an agent that
  // guesses between them states the guess as fact.
  `CREATE TABLE IF NOT EXISTS plan_participants (
     goal_id   TEXT NOT NULL REFERENCES plan_councils(goal_id) ON DELETE CASCADE,
     agent     TEXT NOT NULL,
     joined_at TEXT NOT NULL,
     PRIMARY KEY (goal_id, agent)
   )`,

  // Append-only. The phase is derived from the last row, the way draftState derives the
  // drafting phase from `drafts`. Append-only is what lets the author resolve twice in one
  // round — once on the critique, again on the user's decision — without either overwriting
  // the other.
  `CREATE TABLE IF NOT EXISTS plan_steps (
     goal_id          TEXT NOT NULL REFERENCES plan_councils(goal_id) ON DELETE CASCADE,
     seq              INTEGER NOT NULL,
     round            INTEGER NOT NULL,
     kind             TEXT NOT NULL,
     actor            TEXT NOT NULL,
     critique         TEXT,
     blockers         INTEGER,
     highs            INTEGER,
     mediums          INTEGER,
     lows             INTEGER,
     critic_readiness TEXT,
     applied          TEXT,
     rejected         TEXT,
     additional       TEXT,
     deferred         TEXT,
     needs_user       TEXT,
     author_readiness TEXT,
     decision         TEXT,
     plan_digest      TEXT,
     plan_lines       INTEGER,
     created_at       TEXT NOT NULL,
     PRIMARY KEY (goal_id, seq)
   )`,

  // The implementation council. The third mode, and the first one that runs *after* code is
  // written: the critic checks that what was asked is actually done and actually works,
  // against the diff and against the plan when there is one.
  `CREATE TABLE IF NOT EXISTS impl_councils (
     goal_id       TEXT PRIMARY KEY,
     task          TEXT NOT NULL,
     project_path  TEXT NOT NULL,
     git_branch    TEXT,
     plan_path     TEXT,
     plan_scope    TEXT,
     base_ref      TEXT NOT NULL,
     dirty_at_open INTEGER NOT NULL DEFAULT 0,
     round         INTEGER NOT NULL DEFAULT 1,
     max_rounds    INTEGER NOT NULL DEFAULT 10,
     status        TEXT NOT NULL DEFAULT 'active',
     stop_reason   TEXT,
     started_at    TEXT NOT NULL,
     updated_at    TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS impl_participants (
     goal_id   TEXT NOT NULL REFERENCES impl_councils(goal_id) ON DELETE CASCADE,
     agent     TEXT NOT NULL,
     joined_at TEXT NOT NULL,
     PRIMARY KEY (goal_id, agent)
   )`,

  // Append-only, as plan_steps is, and for the same reason: a decision hands the round back
  // to the author, who then reports twice in one round without overwriting anything.
  `CREATE TABLE IF NOT EXISTS impl_steps (
     goal_id             TEXT NOT NULL REFERENCES impl_councils(goal_id) ON DELETE CASCADE,
     seq                 INTEGER NOT NULL,
     round               INTEGER NOT NULL,
     kind                TEXT NOT NULL,
     actor               TEXT NOT NULL,
     summary             TEXT,
     applied             TEXT,
     rejected            TEXT,
     needs_user          TEXT,
     findings            TEXT,
     blockers            INTEGER,
     highs               INTEGER,
     mediums             INTEGER,
     lows                INTEGER,
     gaps                INTEGER,
     coverage            TEXT,
     verdict             TEXT,
     verification        TEXT,
     report_matches_diff TEXT,
     mismatch            TEXT,
     plan_defect         TEXT,
     decision            TEXT,
     diff_digest         TEXT,
     diff_lines          INTEGER,
     created_at          TEXT NOT NULL,
     PRIMARY KEY (goal_id, seq)
   )`,

  "CREATE INDEX IF NOT EXISTS entries_by_round ON entries (goal_id, round)",
  "CREATE INDEX IF NOT EXISTS councils_by_status ON councils (status)",
  "CREATE INDEX IF NOT EXISTS plan_councils_by_status ON plan_councils (status)",
  "CREATE INDEX IF NOT EXISTS impl_councils_by_status ON impl_councils (status)",
];

// Columns added after a table shipped. CREATE TABLE IF NOT EXISTS does nothing to a table
// that already exists, so a database in the wild keeps the old shape until it is altered.
const MIGRATIONS = [
  ["plan_steps", "plan_digest", "TEXT"],
  ["plan_steps", "plan_lines", "INTEGER"],
  ["plan_steps", "deferred", "TEXT"],
];

// Column defaults that moved after a table shipped. Same cause as MIGRATIONS — the CREATE
// statements above never touch an existing table — but SQLite has no ALTER for a default,
// so the only fix is to rebuild the table from the schema in this file.
//
// Nothing reads these defaults today: every create* function passes max_rounds explicitly.
// They are worth correcting anyway, because a schema on disk that disagrees with the one
// here is a trap set for the first insert that omits the column, and the value it would
// have written silently — 4 — is the cap from three revisions ago.
const DEFAULTS = [
  ["councils", "max_rounds", "10"],
  ["plan_councils", "max_rounds", "10"],
  ["impl_councils", "max_rounds", "10"],
];

/**
 * Rebuild one table from its CREATE statement in SCHEMA, carrying the rows across.
 *
 * Only the columns present in both shapes are copied, so this stays safe if it ever runs
 * against a table that MIGRATIONS has not caught up on. Dropping the table drops its
 * indexes with it; the caller replays SCHEMA afterwards to put them back.
 */
function rebuild(db, table) {
  const create = SCHEMA.find((s) => s.includes(`IF NOT EXISTS ${table} (`));
  if (!create) throw new Error(`no CREATE statement for ${table}`);

  const tmp = `${table}__rebuild`;
  db.prepare(create.replace(`IF NOT EXISTS ${table} (`, `${tmp} (`)).run();

  const after = new Set(db.prepare(`PRAGMA table_info(${tmp})`).all().map((c) => c.name));
  const shared = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name)
    .filter((name) => after.has(name))
    .join(", ");

  db.prepare(`INSERT INTO ${tmp} (${shared}) SELECT ${shared} FROM ${table}`).run();
  db.prepare(`DROP TABLE ${table}`).run();
  db.prepare(`ALTER TABLE ${tmp} RENAME TO ${table}`).run();
}

export function openDatabase(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  for (const pragma of PRAGMAS) db.prepare(pragma).get();
  for (const statement of SCHEMA) db.prepare(statement).run();

  for (const [table, column, type] of MIGRATIONS) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (columns.length && !columns.some((c) => c.name === column)) {
      db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
    }
  }

  const stale = DEFAULTS.filter(([table, column, want]) =>
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .some((c) => c.name === column && String(c.dflt_value) !== want),
  );

  if (stale.length) {
    // Foreign keys must be off across the rebuild, or dropping a parent table cascades the
    // children away — and the pragma is a no-op inside a transaction, so it goes outside.
    db.prepare("PRAGMA foreign_keys = OFF").get();
    try {
      transact(db, () => {
        for (const [table] of stale) rebuild(db, table);
      });
      // The children now point at a table that was dropped and recreated under the same
      // name. Prove that survived rather than assuming it.
      const orphans = db.prepare("PRAGMA foreign_key_check").all();
      if (orphans.length) throw new Error(`rebuild left ${orphans.length} orphaned row(s)`);
      // DROP TABLE took the indexes with it. These are all IF NOT EXISTS.
      for (const statement of SCHEMA) db.prepare(statement).run();
    } finally {
      db.prepare("PRAGMA foreign_keys = ON").get();
    }
  }

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

/**
 * Councils this agent is in whose rounds are over. Whether they are actually finished
 * depends on the drafting phase, which the caller resolves — a council still owing an
 * answer must not be treated as done, or the agent will walk away and start another.
 */
export function getConcludedCouncilsForAgent(db, agent, statuses) {
  const marks = statuses.map(() => "?").join(", ");
  return db
    .prepare(
      `SELECT c.* FROM councils c
       JOIN participants p ON p.goal_id = c.goal_id
       WHERE p.agent = ? AND c.status IN (${marks})
       ORDER BY c.started_at DESC`,
    )
    .all(agent, ...statuses);
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

// ---------------------------------------------------------------------------
// The plan council
// ---------------------------------------------------------------------------

export const PLAN_STATUSES = ["active", "ready", "capped", "needs_user", "error", "aborted"];

// A council parked on a user decision is not finished — it is waiting for a human. It
// still blocks new councils, because the user has to answer it or abandon it.
export const PLAN_UNFINISHED = ["active", "needs_user"];

export function getPlanCouncil(db, goalId) {
  return db.prepare("SELECT * FROM plan_councils WHERE goal_id = ?").get(goalId) ?? null;
}

/**
 * The plan council that still owes work, if any.
 *
 * Both agents are in every plan council by construction — the roles are fixed — so this
 * takes no agent argument. The one-at-a-time guard is a single question either side can ask.
 */
export function getUnfinishedPlanCouncil(db) {
  const marks = PLAN_UNFINISHED.map(() => "?").join(", ");
  return (
    db
      .prepare(
        `SELECT * FROM plan_councils WHERE status IN (${marks})
         ORDER BY started_at DESC LIMIT 1`,
      )
      .get(...PLAN_UNFINISHED) ?? null
  );
}

/** The most recent plan council, finished or not. What `close` falls back to. */
export function getLatestPlanCouncil(db) {
  return (
    db.prepare("SELECT * FROM plan_councils ORDER BY started_at DESC LIMIT 1").get() ?? null
  );
}

export function createPlanCouncil(db, { goalId, planPath, projectPath, gitBranch, maxRounds }) {
  const ts = now();
  db.prepare(
    `INSERT INTO plan_councils
       (goal_id, plan_path, project_path, git_branch, round, max_rounds, status, started_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, 'active', ?, ?)`,
  ).run(goalId, planPath, projectPath, gitBranch ?? null, maxRounds, ts, ts);
  return getPlanCouncil(db, goalId);
}

/**
 * Record that this agent is present, refreshing the timestamp on a re-open.
 *
 * The refresh matters: an open call is proof that someone is alive in that window right
 * now, so re-triggering the skill restarts the wait clock — which is what a user means by
 * re-triggering it. Keeping the first join time would leave a council resumed in a later
 * session looking stale on arrival.
 */
export function joinPlanCouncil(db, goalId, agent) {
  db.prepare(
    `INSERT INTO plan_participants (goal_id, agent, joined_at) VALUES (?, ?, ?)
     ON CONFLICT (goal_id, agent) DO UPDATE SET joined_at = excluded.joined_at`,
  ).run(goalId, agent, now());
}

export function getPlanParticipants(db, goalId) {
  return db
    .prepare("SELECT * FROM plan_participants WHERE goal_id = ? ORDER BY agent")
    .all(goalId);
}

export function getPlanSteps(db, goalId) {
  return db.prepare("SELECT * FROM plan_steps WHERE goal_id = ? ORDER BY seq").all(goalId);
}

/**
 * Append a step. The sequence number is derived inside the same transaction as the read,
 * so two processes cannot mint the same seq — the primary key would reject the second.
 */
export function appendPlanStep(db, goalId, step) {
  const last = db
    .prepare("SELECT MAX(seq) AS seq FROM plan_steps WHERE goal_id = ?")
    .get(goalId);
  const seq = (last?.seq ?? 0) + 1;
  db.prepare(
    `INSERT INTO plan_steps
       (goal_id, seq, round, kind, actor, critique, blockers, highs, mediums, lows,
        critic_readiness, applied, rejected, additional, deferred, needs_user,
        author_readiness, decision, plan_digest, plan_lines, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    goalId,
    seq,
    step.round,
    step.kind,
    step.actor,
    step.critique ?? null,
    step.blockers ?? null,
    step.highs ?? null,
    step.mediums ?? null,
    step.lows ?? null,
    step.critic_readiness ?? null,
    step.applied ?? null,
    step.rejected ?? null,
    step.additional ?? null,
    step.deferred ?? null,
    step.needs_user ?? null,
    step.author_readiness ?? null,
    step.decision ?? null,
    step.plan_digest ?? null,
    step.plan_lines ?? null,
    now(),
  );
  return seq;
}

export function setPlanStatus(db, goalId, status, stopReason = null) {
  if (!PLAN_STATUSES.includes(status)) throw new Error(`unknown plan status: ${status}`);
  db.prepare(
    "UPDATE plan_councils SET status = ?, stop_reason = ?, updated_at = ? WHERE goal_id = ?",
  ).run(status, stopReason, now(), goalId);
}

export function setPlanRound(db, goalId, round) {
  db.prepare("UPDATE plan_councils SET round = ?, updated_at = ? WHERE goal_id = ?").run(
    round,
    now(),
    goalId,
  );
}

// ---------------------------------------------------------------------------
// The implementation council
// ---------------------------------------------------------------------------

export const IMPL_STATUSES = ["active", "ready", "capped", "needs_user", "error", "aborted"];
export const IMPL_UNFINISHED = ["active", "needs_user"];

export function getImplCouncil(db, goalId) {
  return db.prepare("SELECT * FROM impl_councils WHERE goal_id = ?").get(goalId) ?? null;
}

/** Both agents are in every implementation council, so this takes no agent. */
export function getUnfinishedImplCouncil(db) {
  const marks = IMPL_UNFINISHED.map(() => "?").join(", ");
  return (
    db
      .prepare(
        `SELECT * FROM impl_councils WHERE status IN (${marks})
         ORDER BY started_at DESC LIMIT 1`,
      )
      .get(...IMPL_UNFINISHED) ?? null
  );
}

export function getLatestImplCouncil(db) {
  return db.prepare("SELECT * FROM impl_councils ORDER BY started_at DESC LIMIT 1").get() ?? null;
}

export function createImplCouncil(db, c) {
  const ts = now();
  db.prepare(
    `INSERT INTO impl_councils
       (goal_id, task, project_path, git_branch, plan_path, plan_scope, base_ref,
        dirty_at_open, round, max_rounds, status, started_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'active', ?, ?)`,
  ).run(
    c.goalId,
    c.task,
    c.projectPath,
    c.gitBranch ?? null,
    c.planPath ?? null,
    c.planScope ?? null,
    c.baseRef,
    c.dirtyAtOpen ? 1 : 0,
    c.maxRounds,
    ts,
    ts,
  );
  return getImplCouncil(db, c.goalId);
}

export function joinImplCouncil(db, goalId, agent) {
  db.prepare(
    `INSERT INTO impl_participants (goal_id, agent, joined_at) VALUES (?, ?, ?)
     ON CONFLICT (goal_id, agent) DO UPDATE SET joined_at = excluded.joined_at`,
  ).run(goalId, agent, now());
}

export function getImplParticipants(db, goalId) {
  return db
    .prepare("SELECT * FROM impl_participants WHERE goal_id = ? ORDER BY agent")
    .all(goalId);
}

export function getImplSteps(db, goalId) {
  return db.prepare("SELECT * FROM impl_steps WHERE goal_id = ? ORDER BY seq").all(goalId);
}

const IMPL_STEP_COLUMNS = [
  "summary", "applied", "rejected", "needs_user",
  "findings", "blockers", "highs", "mediums", "lows", "gaps", "coverage",
  "verdict", "verification", "report_matches_diff", "mismatch", "plan_defect",
  "decision", "diff_digest", "diff_lines",
];

export function appendImplStep(db, goalId, step) {
  const last = db.prepare("SELECT MAX(seq) AS seq FROM impl_steps WHERE goal_id = ?").get(goalId);
  const seq = (last?.seq ?? 0) + 1;
  const cols = ["goal_id", "seq", "round", "kind", "actor", ...IMPL_STEP_COLUMNS, "created_at"];
  const marks = cols.map(() => "?").join(", ");
  db.prepare(`INSERT INTO impl_steps (${cols.join(", ")}) VALUES (${marks})`).run(
    goalId,
    seq,
    step.round,
    step.kind,
    step.actor,
    ...IMPL_STEP_COLUMNS.map((c) => step[c] ?? null),
    now(),
  );
  return seq;
}

export function setImplStatus(db, goalId, status, stopReason = null) {
  if (!IMPL_STATUSES.includes(status)) throw new Error(`unknown impl status: ${status}`);
  db.prepare(
    "UPDATE impl_councils SET status = ?, stop_reason = ?, updated_at = ? WHERE goal_id = ?",
  ).run(status, stopReason, now(), goalId);
}

export function setImplRound(db, goalId, round) {
  db.prepare("UPDATE impl_councils SET round = ?, updated_at = ? WHERE goal_id = ?").run(
    round,
    now(),
    goalId,
  );
}
