// The plan council: the critique/resolve loop, its stop rules, and the rules it shares
// with the debate mode. Every case in the last describe block came from re-walking the
// state machine rather than from a failed run — the lesson of the drafting phase.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { rmSync, readFileSync } from "node:fs";
import { makeRoot, connect, call, entry, filesIn } from "./harness.js";

const critique = (over = {}) => ({
  critique: "**Needs Fix**\n- [Blocker] The migration has no rollback. Fix: add one.",
  blockers: 1,
  highs: 0,
  mediums: 0,
  lows: 0,
  readiness: "Not ready",
  ...over,
});

const resolution = (over = {}) => ({
  applied: "Added a rollback step to phase 2, per the Blocker.",
  rejected: "None.",
  additional: "None.",
  readiness: "NOT READY",
  ...over,
});

const open = (client, agent, over = {}) =>
  call(client, "plan_council_open", {
    agent,
    plan_path: "/proj/docs/plan.md",
    project_path: "/proj",
    ...over,
  });

describe("a plan council, end to end, with no models", () => {
  let root, claude, codex, goalId;

  before(async () => {
    root = makeRoot("plan-e2e");
    claude = await connect("claude", root);
    codex = await connect("codex", root);
  });

  after(async () => {
    await claude?.close();
    await codex?.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("the author opens it and the critic moves first", async () => {
    const { payload } = await open(claude, "claude");
    assert.equal(payload.ok, true);
    assert.equal(payload.your_role, "author");
    assert.equal(payload.phase, "critique");
    assert.equal(payload.next_actor, "codex");
    assert.equal(payload.max_rounds, 4);
    assert.match(payload.goal_id, /^\d{4}-\d{2}-\d{2}-plan-/);
    assert.match(payload.next_step, /Waiting on codex to critique/);
    goalId = payload.goal_id;
  });

  test("the critic joins it rather than starting another, and is told what to run", async () => {
    const { payload } = await open(codex, "codex");
    assert.equal(payload.goal_id, goalId);
    assert.equal(payload.your_role, "critic");
    assert.match(payload.instruction, /Run your `critique-plan` skill/);
  });

  test("the author cannot critique and the critic cannot resolve", async () => {
    const wrongWay = await call(claude, "plan_council_critique", {
      goal_id: goalId,
      agent: "claude",
      ...critique(),
    });
    assert.equal(wrongWay.isError, true);
    assert.match(wrongWay.payload.error, /codex critiques this council/);

    const otherWay = await call(codex, "plan_council_resolve", {
      goal_id: goalId,
      agent: "codex",
      ...resolution(),
    });
    assert.equal(otherWay.isError, true);
    assert.match(otherWay.payload.error, /claude resolves this council/);
  });

  // The stop signal is the whole reason this mode beats the debate mode. A critic that
  // could wave through its own Blockers would hand it straight back.
  test("Ready over its own Blocker findings is rejected", async () => {
    const { payload, isError } = await call(codex, "plan_council_critique", {
      goal_id: goalId,
      agent: "codex",
      ...critique({ readiness: "Ready" }),
    });
    assert.equal(isError, true);
    assert.equal(payload.field, "readiness");
    assert.match(payload.error, /cannot be Ready with 1 Blocker/);
  });

  test("a critique hands the round to the author, who sees it in full", async () => {
    const submitted = await call(codex, "plan_council_critique", {
      goal_id: goalId,
      agent: "codex",
      ...critique(),
    });
    assert.equal(submitted.payload.phase, "resolve");
    assert.equal(submitted.payload.next_actor, "claude");

    const waited = await call(claude, "plan_council_await", { goal_id: goalId, agent: "claude" });
    assert.equal(waited.payload.arrived, true);
    assert.equal(waited.payload.latest_critique.blockers, 1);
    assert.match(waited.payload.latest_critique.critique, /no rollback/);
    assert.match(waited.payload.instruction, /Run your `plan-critique-resolver` skill/);
  });

  test("resolving starts the next round", async () => {
    const { payload } = await call(claude, "plan_council_resolve", {
      goal_id: goalId,
      agent: "claude",
      ...resolution(),
    });
    assert.equal(payload.phase, "critique");
    assert.equal(payload.next_actor, "codex");
    assert.equal(payload.round, 2);
  });

  test("the critic reporting Ready ends the council", async () => {
    const { payload } = await call(codex, "plan_council_critique", {
      goal_id: goalId,
      agent: "codex",
      ...critique({
        critique: "**Needs Fix**\nNo blocking fixes found.",
        blockers: 0,
        readiness: "Ready",
      }),
    });
    assert.equal(payload.phase, "final");
    assert.equal(payload.status, "ready");
    assert.match(payload.stop_reason, /the critic reported Ready/);
    assert.match(payload.next_step, /ready to implement/);
  });

  test("closing writes the trail, rejections and all", async () => {
    const { payload } = await call(claude, "plan_council_close", {
      goal_id: goalId,
      agent: "claude",
    });
    assert.match(payload.summary, /PLAN COUNCIL .* — ready after 2 critiques/);
    assert.ok(filesIn(join(root, goalId)).includes("trail.md"));

    const file = readFileSync(join(root, goalId, "trail.md"), "utf8");
    assert.match(file, /Round 1 — critique by codex/);
    assert.match(file, /Round 1 — resolution by claude/);
    assert.match(file, /Added a rollback step/);
    assert.match(file, /docs\/plan\.md/);
  });

  test("joining a council about a different plan warns rather than going quiet", async () => {
    const other = makeRoot("plan-mixup");
    const c2 = await connect("claude", other);
    const x2 = await connect("codex", other);
    await open(c2, "claude", { plan_path: "/proj/docs/first.md" });

    const { payload } = await open(x2, "codex", { plan_path: "/proj/docs/second.md" });
    assert.equal(payload.plan_path, "/proj/docs/first.md");
    assert.match(payload.warning, /you asked for \/proj\/docs\/second\.md/);

    await c2.close();
    await x2.close();
    rmSync(other, { recursive: true, force: true });
  });

  test("a finished plan council no longer blocks a new one", async () => {
    const { payload } = await open(claude, "claude", { plan_path: "/proj/docs/other.md" });
    assert.notEqual(payload.goal_id, goalId);
    await call(claude, "council_abandon", { agent: "claude", reason: "cleanup" });
  });
});

// Without this rule the loop never ends on its own: every revision creates new surface, so
// a thorough critic keeps finding Medium issues forever.
describe("the severity gate after round 2", () => {
  let root, claude, codex, goalId;

  const mediumOnly = critique({
    critique: "**Needs Fix**\n- [Medium] The error message could name the field.",
    blockers: 0,
    mediums: 2,
    readiness: "Not ready",
  });

  before(async () => {
    root = makeRoot("plan-gate");
    claude = await connect("claude", root);
    codex = await connect("codex", root);
    goalId = (await open(claude, "claude")).payload.goal_id;
    await open(codex, "codex");
  });

  after(async () => {
    await claude?.close();
    await codex?.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("Medium findings still block on rounds 1 and 2", async () => {
    for (const round of [1, 2]) {
      const critiqued = await call(codex, "plan_council_critique", {
        goal_id: goalId,
        agent: "codex",
        ...mediumOnly,
      });
      assert.equal(critiqued.payload.phase, "resolve", `round ${round} should not end`);
      assert.equal(critiqued.payload.status, "active");

      const resolved = await call(claude, "plan_council_resolve", {
        goal_id: goalId,
        agent: "claude",
        ...resolution(),
      });
      assert.equal(resolved.payload.round, round + 1);
    }
  });

  test("from round 3 only Blocker and High hold the plan back", async () => {
    const { payload } = await call(codex, "plan_council_critique", {
      goal_id: goalId,
      agent: "codex",
      ...mediumOnly,
    });
    assert.equal(payload.status, "ready");
    assert.match(payload.stop_reason, /no Blocker or High findings remained at round 3/);
    assert.match(payload.stop_reason, /2 Medium\/Low findings left standing/);
  });
});

describe("a decision that is the user's to make", () => {
  let root, claude, codex, goalId;

  before(async () => {
    root = makeRoot("plan-decision");
    claude = await connect("claude", root);
    codex = await connect("codex", root);
    goalId = (await open(claude, "claude")).payload.goal_id;
    await open(codex, "codex");
    await call(codex, "plan_council_critique", { goal_id: goalId, agent: "codex", ...critique() });
    await call(claude, "plan_council_resolve", {
      goal_id: goalId,
      agent: "claude",
      ...resolution({
        needs_user_decision: "Roll back by migration or by snapshot restore? Both are viable.",
      }),
    });
  });

  after(async () => {
    await claude?.close();
    await codex?.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("it parks the council and hands back rather than being guessed at", async () => {
    const { payload } = await call(claude, "plan_council_close", {
      goal_id: goalId,
      agent: "claude",
    });
    assert.equal(payload.status, "needs_user");
    assert.equal(payload.phase, "user");
    assert.match(payload.summary, /Waiting on you to decide/);
    assert.match(payload.summary, /snapshot restore/);
  });

  // Parked is not stalled. If the stall timer ran here the council would die as `error`
  // while the user was thinking about the very question it asked them.
  test("the waiting peer is released at once, not held for the timeout", async () => {
    const started = Date.now();
    const { payload } = await call(codex, "plan_council_await", { goal_id: goalId, agent: "codex" });
    assert.equal(payload.retry, false);
    assert.match(payload.note, /waiting on the user/);
    assert.ok(Date.now() - started < 1500, "should return immediately, not poll");
  });

  test("nothing advances until the decision arrives", async () => {
    const { payload, isError } = await call(codex, "plan_council_critique", {
      goal_id: goalId,
      agent: "codex",
      ...critique(),
    });
    assert.equal(isError, true);
    assert.match(payload.error, /waiting on a decision from the user/);
  });

  test("the decision hands the same round back to the author", async () => {
    const { payload } = await call(claude, "plan_council_resume", {
      agent: "claude",
      decision: "Snapshot restore. The migration path is not worth the operational cost.",
    });
    assert.equal(payload.status, "active");
    assert.equal(payload.phase, "resolve");
    assert.equal(payload.next_actor, "claude");
    assert.equal(payload.round, 1, "a decision must not burn a round");
    assert.match(payload.instruction, /The user has answered/);
  });

  test("resolving again moves on, and the trail keeps the decision", async () => {
    const { payload } = await call(claude, "plan_council_resolve", {
      goal_id: goalId,
      agent: "claude",
      ...resolution({ applied: "Rollback is now a snapshot restore, per the user." }),
    });
    assert.equal(payload.phase, "critique");
    assert.equal(payload.round, 2);

    await call(claude, "plan_council_close", { goal_id: goalId, agent: "claude" });
    const file = readFileSync(join(root, goalId, "trail.md"), "utf8");
    assert.match(file, /Round 1 — the user decided/);
    assert.match(file, /operational cost/);
  });

  test("resuming a council that is not parked says so", async () => {
    const { payload, isError } = await call(claude, "plan_council_resume", {
      agent: "claude",
      goal_id: goalId,
      decision: "Another thought.",
    });
    assert.equal(isError, true);
    assert.match(payload.error, /not waiting on a decision/);
  });
});

describe("the round cap", () => {
  let root, claude, codex, goalId;

  before(async () => {
    root = makeRoot("plan-cap");
    claude = await connect("claude", root);
    codex = await connect("codex", root);
    goalId = (await open(claude, "claude", { max_rounds: 2 })).payload.goal_id;
    await open(codex, "codex");
  });

  after(async () => {
    await claude?.close();
    await codex?.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("the last critique is answered before the cap stops it", async () => {
    let payload;
    for (const round of [1, 2]) {
      const critiqued = await call(codex, "plan_council_critique", {
        goal_id: goalId,
        agent: "codex",
        ...critique(),
      });
      assert.equal(critiqued.payload.phase, "resolve", `round ${round} critique`);

      ({ payload } = await call(claude, "plan_council_resolve", {
        goal_id: goalId,
        agent: "claude",
        ...resolution(),
      }));
    }

    // The final round's fixes are applied before the cap stops it — the cap's job is to
    // guarantee the loop ends, not to cut the last critique off unanswered.
    assert.equal(payload.status, "capped");
    assert.equal(payload.phase, "final");
    assert.match(payload.stop_reason, /reached the 2-round cap/);

    const closed = await call(claude, "plan_council_close", { goal_id: goalId, agent: "claude" });
    assert.match(closed.payload.summary, /The cap stopped this, not the critic/);
  });
});

describe("a peer that stops responding", () => {
  let root, claude, codex, goalId;

  before(async () => {
    root = makeRoot("plan-stall");
    process.env.COUNCIL_TOTAL_WAIT_MS = "1";
    claude = await connect("claude", root);
    codex = await connect("codex", root);
    goalId = (await open(claude, "claude")).payload.goal_id;
  });

  after(async () => {
    delete process.env.COUNCIL_TOTAL_WAIT_MS;
    await claude?.close();
    await codex?.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("the author is released and told the plan file is untouched", async () => {
    const { payload } = await call(claude, "plan_council_await", { goal_id: goalId, agent: "claude" });
    assert.equal(payload.retry, false);
    assert.equal(payload.status, "error");
    assert.match(payload.stop_reason, /codex did not critique round 1/);
    assert.match(payload.note, /plan file keeps every fix applied/);
  });
});

// The rules that branch on status have to see both modes. Each of these is a rule that
// existed before this mode and did not know about it.
describe("one council at a time, across both modes", () => {
  let root, claude, codex;

  before(async () => {
    root = makeRoot("plan-guard");
    claude = await connect("claude", root);
    codex = await connect("codex", root);
  });

  after(async () => {
    await claude?.close();
    await codex?.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("an unfinished plan council blocks a debate council, and names itself", async () => {
    const { payload: plan } = await open(claude, "claude");

    const blocked = await call(claude, "council_open", {
      agent: "claude",
      question: "Something else entirely",
      project_path: "/proj",
    });
    assert.equal(blocked.isError, true);
    assert.equal(blocked.payload.blocking.goal_id, plan.goal_id);
    assert.match(blocked.payload.error, /critique owed by codex/);

    // It blocks the peer too, not only the agent that opened it.
    const peerBlocked = await call(codex, "council_open", {
      agent: "codex",
      question: "Something else entirely",
      project_path: "/proj",
    });
    assert.equal(peerBlocked.isError, true);
  });

  test("council_status points at the plan council instead of claiming there is none", async () => {
    const { payload } = await call(codex, "council_status", { agent: "codex" });
    assert.equal(payload.mode, "plan_council");
    assert.equal(payload.phase, "critique");
    assert.match(payload.note, /Call plan_council_open/);
  });

  test("council_abandon is the kill switch for both modes", async () => {
    const { payload } = await call(codex, "council_abandon", {
      agent: "codex",
      reason: "wrong plan file",
    });
    assert.equal(payload.status, "aborted");
    assert.match(payload.note, /either mode/);

    const fresh = await call(claude, "council_open", {
      agent: "claude",
      question: "Now unblocked",
      project_path: "/proj",
    });
    assert.equal(fresh.isError ?? false, false);
    assert.equal(fresh.payload.round, 1);
  });

  test("an unfinished debate council blocks a plan council", async () => {
    const blocked = await open(claude, "claude");
    assert.equal(blocked.isError, true);
    assert.match(blocked.payload.error, /unfinished council/);
    assert.equal(blocked.payload.blocking_mode, "council");

    await call(claude, "council_abandon", { agent: "claude", reason: "cleanup" });
    const { payload } = await open(claude, "claude");
    assert.equal(payload.phase, "critique");
    await call(claude, "council_abandon", { agent: "claude", reason: "cleanup" });
  });

  // The debate mode's own guard must keep working: a plan council in a terminal state is
  // not unfinished work, and must not lock the other mode out forever.
  test("an abandoned plan council stops blocking", async () => {
    const { payload } = await call(claude, "council_open", {
      agent: "claude",
      question: "Still fine",
      project_path: "/proj",
    });
    assert.equal(payload.round, 1);
    await call(claude, "council_submit", { goal_id: payload.goal_id, agent: "claude", ...entry() });
    await call(claude, "council_abandon", { agent: "claude", reason: "cleanup" });
  });
});
