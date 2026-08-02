// Interruption and abandonment. Every case here came from reasoning through the state
// machine rather than from a failure, because the failures were arriving one per run.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { rmSync, readFileSync } from "node:fs";
import { makeRoot, connect, call, entry, filesIn } from "./harness.js";

async function twoRoundCouncil(claude, codex, question) {
  const opened = await call(claude, "council_open", {
    agent: "claude",
    question,
    project_path: "/proj",
    max_rounds: 2,
  });
  const goalId = opened.payload.goal_id;
  await call(codex, "council_open", { agent: "codex" });
  await call(claude, "council_submit", { goal_id: goalId, agent: "claude", ...entry() });
  await call(codex, "council_submit", { goal_id: goalId, agent: "codex", ...entry() });
  await call(claude, "council_submit", {
    goal_id: goalId,
    agent: "claude",
    ...entry({ verdict_on_peer: "AGREE" }),
  });
  await call(codex, "council_submit", {
    goal_id: goalId,
    agent: "codex",
    ...entry({ verdict_on_peer: "AGREE" }),
  });
  return goalId;
}

describe("abandoning a council", () => {
  let root, claude, codex, goalId;

  before(async () => {
    root = makeRoot("abandon");
    claude = await connect("claude", root);
    codex = await connect("codex", root);
    const opened = await call(claude, "council_open", {
      agent: "claude",
      question: "A question the peer never answers",
      project_path: "/proj",
    });
    goalId = opened.payload.goal_id;
  });

  after(async () => {
    await claude?.close();
    await codex?.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("a stuck council blocks a new one until abandoned", async () => {
    const blocked = await call(claude, "council_open", {
      agent: "claude",
      question: "Something else entirely",
      project_path: "/other",
    });
    assert.equal(blocked.payload.goal_id, goalId, "the old council should be returned");

    const { payload } = await call(claude, "council_abandon", {
      agent: "claude",
      reason: "codex never joined and I want to ask something else",
    });
    assert.equal(payload.status, "aborted");

    const fresh = await call(claude, "council_open", {
      agent: "claude",
      question: "Something else entirely",
      project_path: "/other",
    });
    assert.notEqual(fresh.payload.goal_id, goalId, "a new council should now start");
    await call(claude, "council_abandon", { agent: "claude", reason: "cleanup" });
  });

  test("abandoning twice is harmless", async () => {
    const { payload } = await call(claude, "council_abandon", {
      agent: "claude",
      goal_id: goalId,
      reason: "again",
    });
    assert.equal(payload.ok, true);
    assert.match(payload.note, /already abandoned/);
  });

  test("abandoning with no council to abandon says so", async () => {
    const { payload, isError } = await call(codex, "council_abandon", {
      agent: "codex",
      reason: "nothing here",
    });
    assert.equal(isError, true);
    assert.match(payload.error, /no unfinished council/);
  });
});

describe("a reviewer that never responds", () => {
  let root, claude, codex, goalId;

  before(async () => {
    root = makeRoot("stalled");
    // A one-millisecond total wait makes the stall immediate.
    process.env.COUNCIL_TOTAL_WAIT_MS = "1";
    claude = await connect("claude", root);
    codex = await connect("codex", root);
    goalId = await twoRoundCouncil(claude, codex, "Stalled review test");
    await call(claude, "council_draft", {
      goal_id: goalId,
      agent: "claude",
      answer: "A good answer nobody reviewed.",
    });
  });

  after(async () => {
    delete process.env.COUNCIL_TOTAL_WAIT_MS;
    await claude?.close();
    await codex?.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("the draft stands as the answer rather than being thrown away", async () => {
    const { payload } = await call(claude, "council_await_peer", {
      goal_id: goalId,
      agent: "claude",
    });
    assert.equal(payload.phase, "final");
    assert.match(payload.final_reason, /stands unreviewed/);

    const closed = await call(claude, "council_close", { goal_id: goalId, agent: "claude" });
    assert.match(closed.payload.answer, /nobody reviewed/);
    assert.ok(filesIn(join(root, goalId)).includes("answer.md"));

    // And it says plainly that only one model stands behind it.
    const file = readFileSync(join(root, goalId, "answer.md"), "utf8");
    assert.match(file, /Never reviewed/);
    assert.match(file, /One model's answer, not two/);
  });

  test("a finished council no longer blocks a new one", async () => {
    const fresh = await call(claude, "council_open", {
      agent: "claude",
      question: "A brand new question",
      project_path: "/proj",
    });
    assert.notEqual(fresh.payload.goal_id, goalId);
    await call(claude, "council_abandon", { agent: "claude", reason: "cleanup" });
  });
});

describe("a drafter that never drafts", () => {
  let root, claude, codex, goalId;

  before(async () => {
    root = makeRoot("nodraft");
    process.env.COUNCIL_TOTAL_WAIT_MS = "1";
    claude = await connect("claude", root);
    codex = await connect("codex", root);
    goalId = await twoRoundCouncil(claude, codex, "No draft test");
  });

  after(async () => {
    delete process.env.COUNCIL_TOTAL_WAIT_MS;
    await claude?.close();
    await codex?.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("the reviewer is released and the round record survives", async () => {
    const { payload } = await call(codex, "council_await_peer", { goal_id: goalId, agent: "codex" });
    assert.equal(payload.arrived, false);
    assert.equal(payload.retry, false);
    assert.equal(payload.status, "error");
    assert.match(payload.note, /never drafted/);
  });
});
