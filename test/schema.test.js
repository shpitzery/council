// Schema drift. A database created by an older build keeps its original shape forever —
// CREATE TABLE IF NOT EXISTS is silent about a table that already exists — and the cap
// that shipped as 4, then 5, then 10 is the column that proved it.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db.js";

/** A database in the shape it had when the cap was 4, with one council and one step. */
function oldDatabase() {
  const dir = mkdtempSync(join(tmpdir(), "council-schema-"));
  const path = join(dir, "council.db");
  const db = new DatabaseSync(path);

  db.prepare("PRAGMA foreign_keys = ON").get();
  db.prepare(
    `CREATE TABLE plan_councils (
       goal_id      TEXT PRIMARY KEY,
       plan_path    TEXT NOT NULL,
       project_path TEXT NOT NULL,
       git_branch   TEXT,
       round        INTEGER NOT NULL DEFAULT 1,
       max_rounds   INTEGER NOT NULL DEFAULT 4,
       status       TEXT NOT NULL DEFAULT 'active',
       stop_reason  TEXT,
       started_at   TEXT NOT NULL,
       updated_at   TEXT NOT NULL
     )`,
  ).run();
  db.prepare(
    `CREATE TABLE plan_participants (
       goal_id   TEXT NOT NULL REFERENCES plan_councils(goal_id) ON DELETE CASCADE,
       agent     TEXT NOT NULL,
       joined_at TEXT NOT NULL,
       PRIMARY KEY (goal_id, agent)
     )`,
  ).run();

  db.prepare(
    `INSERT INTO plan_councils
       (goal_id, plan_path, project_path, round, max_rounds, status, started_at, updated_at)
     VALUES ('g1', '/p/plan.md', '/proj', 3, 5, 'capped', 't0', 't1')`,
  ).run();
  db.prepare(
    "INSERT INTO plan_participants (goal_id, agent, joined_at) VALUES ('g1', 'claude', 't0')",
  ).run();
  db.close();
  return { dir, path };
}

const defaultOf = (db, table, column) =>
  db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .find((c) => c.name === column)?.dflt_value;

describe("opening a database written by an older build", () => {
  test("corrects a stale column default, and keeps the rows", () => {
    const { dir, path } = oldDatabase();
    try {
      const db = openDatabase(path);

      assert.equal(String(defaultOf(db, "plan_councils", "max_rounds")), "10");
      assert.equal(String(defaultOf(db, "councils", "max_rounds")), "10");
      assert.equal(String(defaultOf(db, "impl_councils", "max_rounds")), "10");

      // The council survives the rebuild unchanged — including its own cap, which is the
      // number the council was opened under and must not be rewritten to the new default.
      const council = db.prepare("SELECT * FROM plan_councils WHERE goal_id = 'g1'").get();
      assert.equal(council.max_rounds, 5);
      assert.equal(council.round, 3);
      assert.equal(council.status, "capped");
      assert.equal(council.plan_path, "/p/plan.md");

      // Dropping the parent must not have cascaded the children away.
      const joined = db.prepare("SELECT * FROM plan_participants WHERE goal_id = 'g1'").all();
      assert.equal(joined.length, 1);
      assert.equal(joined[0].agent, "claude");
      assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);

      // The index went with the dropped table and has to have been put back.
      const indexes = db.prepare("PRAGMA index_list(plan_councils)").all();
      assert.ok(indexes.some((i) => i.name === "plan_councils_by_status"));

      // Foreign keys are back on for the process that will use this handle.
      assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("is a no-op the second time, and on a database it just created", () => {
    const { dir, path } = oldDatabase();
    try {
      openDatabase(path).close();
      const db = openDatabase(path);
      assert.equal(String(defaultOf(db, "plan_councils", "max_rounds")), "10");
      assert.equal(db.prepare("SELECT COUNT(*) n FROM plan_councils").get().n, 1);
      assert.ok(!db.prepare("PRAGMA table_list").all().some((t) => t.name.endsWith("__rebuild")));
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
