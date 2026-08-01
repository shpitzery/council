import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { makeRoot, connect, call, entry, filesIn } from "./harness.js";

describe("a council, end to end, with no models", () => {
  let root, claude, codex, goalId;

  before(async () => {
    root = makeRoot("e2e");
    claude = await connect("claude", root);
    codex = await connect("codex", root);
  });

  after(async () => {
    await claude?.close();
    await codex?.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("the first caller starts the council", async () => {
    const { payload } = await call(claude, "council_open", {
      agent: "claude",
      question: "Should we fix the cache key or the test?",
      project_path: "/proj",
      max_rounds: 3,
    });
    assert.equal(payload.ok, true);
    assert.equal(payload.round, 1);
    assert.equal(payload.waiting_for_peer, true);
    goalId = payload.goal_id;
    assert.match(goalId, /^\d{4}-\d{2}-\d{2}-/);
  });

  test("the second caller joins it rather than starting another", async () => {
    const { payload } = await call(codex, "council_open", { agent: "codex" });
    assert.equal(payload.goal_id, goalId);
    assert.deepEqual(payload.participants.sort(), ["claude", "codex"]);
  });

  test("a verdict on round 1 is rejected — the peer cannot have been seen", async () => {
    const { payload, isError } = await call(claude, "council_submit", {
      goal_id: goalId,
      agent: "claude",
      ...entry({ verdict_on_peer: "AGREE" }),
    });
    assert.equal(isError, true);
    assert.equal(payload.field, "verdict_on_peer");
  });

  test("round 1: one side in, nothing revealed", async () => {
    const { payload } = await call(claude, "council_submit", {
      goal_id: goalId,
      agent: "claude",
      ...entry(),
    });
    assert.equal(payload.ok, true);
    assert.equal(payload.peer_submitted, false);

    // The barrier: no round-1 file exists yet, for either side.
    assert.deepEqual(filesIn(join(root, goalId)), ["brief.md"]);
  });

  test("submitting twice for the same round is rejected", async () => {
    const { isError } = await call(claude, "council_submit", {
      goal_id: goalId,
      agent: "claude",
      ...entry({ position: "A second, different answer." }),
    });
    assert.equal(isError, true);
  });

  test("awaiting before the peer answers returns retry, not the answer", async () => {
    const { payload } = await call(claude, "council_await_peer", {
      goal_id: goalId,
      agent: "claude",
    });
    assert.equal(payload.arrived, false);
    assert.equal(payload.retry, true);
    assert.equal(payload.peer_entry, undefined);
  });

  test("both in: round 1 is revealed and the round advances", async () => {
    const { payload } = await call(codex, "council_submit", {
      goal_id: goalId,
      agent: "codex",
      ...entry({ position: "Fix the test; the assertion is stale." }),
    });
    assert.equal(payload.peer_submitted, true);
    assert.equal(payload.stopped, false);
    assert.equal(payload.round, 2);

    assert.deepEqual(filesIn(join(root, goalId)), [
      "brief.md",
      "r1-claude.json",
      "r1-codex.json",
    ]);
  });

  test("the peer's answer is now readable, and only now", async () => {
    const { payload } = await call(claude, "council_await_peer", {
      goal_id: goalId,
      agent: "claude",
    });
    assert.equal(payload.arrived, true);
    assert.equal(payload.peer_entry.agent, "codex");
    assert.match(payload.peer_entry.position, /stale/);
  });

  test("DISAGREE without a quoted line is rejected", async () => {
    const { payload, isError } = await call(claude, "council_submit", {
      goal_id: goalId,
      agent: "claude",
      ...entry({ verdict_on_peer: "DISAGREE" }),
    });
    assert.equal(isError, true);
    assert.equal(payload.field, "disagreement");
  });

  test("UNRESOLVED without a settling test is rejected", async () => {
    const { payload, isError } = await call(codex, "council_submit", {
      goal_id: goalId,
      agent: "codex",
      ...entry({ verdict_on_peer: "UNRESOLVED" }),
    });
    assert.equal(isError, true);
    assert.equal(payload.field, "settling_test");
  });

  test("round 2 completes and the council keeps going", async () => {
    await call(claude, "council_submit", {
      goal_id: goalId,
      agent: "claude",
      ...entry({
        verdict_on_peer: "DISAGREE",
        disagreement: "Peer wrote 'the assertion is stale' — it matches docs/multitenancy.md:12.",
      }),
    });
    const { payload } = await call(codex, "council_submit", {
      goal_id: goalId,
      agent: "codex",
      ...entry({
        verdict_on_peer: "DISAGREE",
        disagreement: "Peer wrote 'the key omits the tenant id' — it is added at keys.py:58.",
      }),
    });
    assert.equal(payload.stopped, false);
    assert.equal(payload.round, 3);
  });

  test("the round cap stops it even while both still disagree", async () => {
    await call(claude, "council_await_peer", { goal_id: goalId, agent: "claude" });
    await call(claude, "council_submit", {
      goal_id: goalId,
      agent: "claude",
      ...entry({ verdict_on_peer: "DISAGREE", disagreement: "Still contests keys.py:58." }),
    });
    const { payload } = await call(codex, "council_submit", {
      goal_id: goalId,
      agent: "codex",
      ...entry({ verdict_on_peer: "DISAGREE", disagreement: "Still contests docs line 12." }),
    });

    assert.equal(payload.stopped, true);
    assert.equal(payload.status, "capped");
    assert.match(payload.stop_reason, /max_rounds/);
  });

  test("the verdict renders and names why it stopped", async () => {
    const { payload } = await call(claude, "council_close", { goal_id: goalId, agent: "claude" });
    assert.match(payload.summary, /capped after 3 rounds/);
    assert.match(payload.summary, /max_rounds/);
    // The label names who objects and to whom — the quoted text is the peer's line.
    assert.match(payload.summary, /claude contests codex's:/);
    assert.match(payload.summary, /codex contests claude's:/);
    assert.ok(filesIn(join(root, goalId)).includes("verdict.md"));
  });

  test("a stopped council refuses further submissions", async () => {
    const { payload, isError } = await call(claude, "council_submit", {
      goal_id: goalId,
      agent: "claude",
      ...entry({ verdict_on_peer: "AGREE" }),
    });
    assert.equal(isError, true);
    assert.equal(payload.field, "status");
  });
});

describe("the kill switch", () => {
  let root, claude, codex, goalId;

  before(async () => {
    root = makeRoot("abort");
    claude = await connect("claude", root);
    codex = await connect("codex", root);
    const opened = await call(claude, "council_open", {
      agent: "claude",
      question: "Abort test",
      project_path: "/proj",
    });
    goalId = opened.payload.goal_id;
    await call(codex, "council_open", { agent: "codex" });
    await call(claude, "council_submit", { goal_id: goalId, agent: "claude", ...entry() });
  });

  after(async () => {
    await claude?.close();
    await codex?.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("setting the status to aborted releases a waiting agent", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(root, "council.db"));
    db.prepare("UPDATE councils SET status = 'aborted' WHERE goal_id = ?").run(goalId);

    const { payload } = await call(claude, "council_await_peer", {
      goal_id: goalId,
      agent: "claude",
    });
    assert.equal(payload.arrived, false);
    assert.equal(payload.retry, false);
    assert.match(payload.note, /aborted/);
  });
});

describe("a peer that never answers", () => {
  let root, claude, goalId;

  before(async () => {
    root = makeRoot("timeout");
    process.env.COUNCIL_TOTAL_WAIT_MS = "1";
    claude = await connect("claude", root);
    const opened = await call(claude, "council_open", {
      agent: "claude",
      question: "Timeout test",
      project_path: "/proj",
    });
    goalId = opened.payload.goal_id;
    await call(claude, "council_submit", { goal_id: goalId, agent: "claude", ...entry() });
  });

  after(async () => {
    delete process.env.COUNCIL_TOTAL_WAIT_MS;
    await claude?.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("the council is marked error and the record survives", async () => {
    const { payload } = await call(claude, "council_await_peer", {
      goal_id: goalId,
      agent: "claude",
    });
    assert.equal(payload.arrived, false);
    assert.equal(payload.retry, false);
    assert.equal(payload.status, "error");
    assert.match(payload.note, /never answered/);
  });
});
