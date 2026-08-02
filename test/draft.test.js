import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { rmSync, readFileSync } from "node:fs";
import { makeRoot, connect, call, entry, filesIn } from "./harness.js";

/** Run a two-round council to completion so the drafting phase can start. */
async function finishedCouncil(root, claude, codex, question) {
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
  const last = await call(codex, "council_submit", {
    goal_id: goalId,
    agent: "codex",
    ...entry({ verdict_on_peer: "AGREE" }),
  });
  assert.equal(last.payload.stopped, true);
  return goalId;
}

describe("the drafting phase", () => {
  let root, claude, codex, goalId;

  before(async () => {
    root = makeRoot("draft");
    claude = await connect("claude", root);
    codex = await connect("codex", root);
    goalId = await finishedCouncil(root, claude, codex, "Should we fix the cache key?");
  });

  after(async () => {
    await claude?.close();
    await codex?.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("the first to join is the drafter, and is told so", async () => {
    const { payload } = await call(claude, "council_status", { goal_id: goalId, agent: "claude" });
    assert.equal(payload.status, "converged");
    const waited = await call(claude, "council_await_peer", { goal_id: goalId, agent: "claude" });
    assert.equal(waited.payload.drafter, "claude");
    assert.equal(waited.payload.next_actor, "claude");
    assert.equal(waited.payload.phase, "draft");
    assert.match(waited.payload.instruction, /what you would tell them if they had/);
  });

  test("the reviewer cannot draft", async () => {
    const { payload, isError } = await call(codex, "council_draft", {
      goal_id: goalId,
      agent: "codex",
      answer: "I am not the drafter.",
    });
    assert.equal(isError, true);
    assert.match(payload.error, /claude drafts this council/);
  });

  test("the drafter cannot review its own draft", async () => {
    await call(claude, "council_draft", {
      goal_id: goalId,
      agent: "claude",
      answer: "Fix the cache key first. Everything else can wait.",
    });
    const { payload, isError } = await call(claude, "council_review", {
      goal_id: goalId,
      agent: "claude",
      verdict: "APPROVE",
    });
    assert.equal(isError, true);
    assert.match(payload.error, /codex reviews this council/);
  });

  test("the reviewer sees the draft and its review instruction", async () => {
    const { payload } = await call(codex, "council_await_peer", { goal_id: goalId, agent: "codex" });
    assert.equal(payload.phase, "review");
    assert.equal(payload.next_actor, "codex");
    assert.match(payload.latest_draft.answer, /Fix the cache key first/);
    assert.match(payload.instruction, /APPROVE only if you would be content/);
  });

  test("REVISE without specifics is rejected", async () => {
    const { payload, isError } = await call(codex, "council_review", {
      goal_id: goalId,
      agent: "codex",
      verdict: "REVISE",
    });
    assert.equal(isError, true);
    assert.equal(payload.field, "revisions");
  });

  test("REVISE sends it back to the drafter", async () => {
    const { payload } = await call(codex, "council_review", {
      goal_id: goalId,
      agent: "codex",
      verdict: "REVISE",
      revisions: "'Everything else can wait' overstates it — the tenant fixture is still open.",
    });
    assert.equal(payload.phase, "draft");
    assert.equal(payload.next_actor, "claude");
    assert.equal(payload.revision, 2);
    assert.equal(payload.reviews_remaining, 1);
  });

  test("an approved revision becomes final and writes answer.md", async () => {
    await call(claude, "council_draft", {
      goal_id: goalId,
      agent: "claude",
      answer: "Fix the cache key first. The tenant fixture stays open — decide that separately.",
    });
    const reviewed = await call(codex, "council_review", {
      goal_id: goalId,
      agent: "codex",
      verdict: "APPROVE",
    });
    assert.equal(reviewed.payload.phase, "final");
    assert.match(reviewed.payload.final_reason, /codex approved revision 2/);

    const closed = await call(claude, "council_close", { goal_id: goalId, agent: "claude" });
    assert.match(closed.payload.answer, /tenant fixture stays open/);
    assert.ok(filesIn(join(root, goalId)).includes("answer.md"));

    const file = readFileSync(join(root, goalId, "answer.md"), "utf8");
    assert.match(file, /# Should we fix the cache key\?/);
    assert.match(file, /Approved by codex/);
  });

  // Regression: Codex saw "converged", read that as finished, and opened a second council
  // while Claude was mid-draft on the first. Claude then waited for a review that was never
  // coming, and Codex waited for Claude to join a council it did not know about. Two
  // agents, two councils, each blocked on the other.
  test("an unfinished answer blocks starting another council", async () => {
    const draftRoot = makeRoot("nostart");
    const c2 = await connect("claude", draftRoot);
    const x2 = await connect("codex", draftRoot);
    const id = await finishedCouncil(draftRoot, c2, x2, "Blocking test");

    await call(c2, "council_draft", {
      goal_id: id,
      agent: "claude",
      answer: "An answer awaiting review.",
    });

    // Codex owes a review. Opening a new council must return the old one instead.
    const { payload } = await call(x2, "council_open", {
      agent: "codex",
      question: "A completely different question",
      project_path: "/other",
    });
    assert.equal(payload.goal_id, id);
    assert.equal(payload.phase, "review");
    assert.equal(payload.next_actor, "codex");
    assert.match(payload.next_step, /You owe the review/);

    // And the drafter is told to wait rather than start something new.
    const drafterView = await call(c2, "council_open", {
      agent: "claude",
      question: "Another different question",
      project_path: "/other",
    });
    assert.equal(drafterView.payload.goal_id, id);
    assert.match(drafterView.payload.next_step, /Waiting on codex to review/);
    assert.match(drafterView.payload.instruction, /Do not start another council/);

    await c2.close();
    await x2.close();
    rmSync(draftRoot, { recursive: true, force: true });
  });

  test("further drafting is refused once final", async () => {
    const { payload, isError } = await call(claude, "council_draft", {
      goal_id: goalId,
      agent: "claude",
      answer: "One more thought.",
    });
    assert.equal(isError, true);
    assert.match(payload.error, /already final/);
  });
});

describe("when the review budget runs out", () => {
  let root, claude, codex, goalId;

  before(async () => {
    root = makeRoot("budget");
    claude = await connect("claude", root);
    codex = await connect("codex", root);
    goalId = await finishedCouncil(root, claude, codex, "Budget test");
  });

  after(async () => {
    await claude?.close();
    await codex?.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("two REVISE verdicts exhaust it and the third draft ships as it stands", async () => {
    for (const revision of [1, 2]) {
      await call(claude, "council_draft", {
        goal_id: goalId,
        agent: "claude",
        answer: `Draft ${revision}.`,
      });
      const { payload } = await call(codex, "council_review", {
        goal_id: goalId,
        agent: "codex",
        verdict: "REVISE",
        revisions: `Still wrong, attempt ${revision}.`,
      });
      assert.equal(payload.revision, revision + 1);
    }

    await call(claude, "council_draft", { goal_id: goalId, agent: "claude", answer: "Draft 3." });

    const { payload } = await call(codex, "council_review", {
      goal_id: goalId,
      agent: "codex",
      verdict: "REVISE",
      revisions: "Never satisfied.",
    });
    assert.equal(payload.isError ?? false, false);
    const view = await call(codex, "council_await_peer", { goal_id: goalId, agent: "codex" });
    assert.equal(view.payload.phase, "final");
    assert.match(view.payload.final_reason, /review budget of 2 is spent/);

    // The disagreement is recorded, not buried.
    const closed = await call(claude, "council_close", { goal_id: goalId, agent: "claude" });
    assert.match(closed.payload.answer, /Draft 3/);
    const file = readFileSync(join(root, goalId, "answer.md"), "utf8");
    assert.match(file, /review budget was spent|Shipped without approval/);
  });
});
