// The plan council: the critique/resolve loop, its stop rules, and the rules it shares
// with the debate mode. Every case in the last describe block came from re-walking the
// state machine rather than from a failed run — the lesson of the drafting phase.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
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

  // The critic found no open council, listed the plans directory, picked a file itself and
  // opened a second council on its guess. It guessed right that time.
  test("the critic cannot start one, even holding a plan path", async () => {
    const { payload, isError } = await open(codex, "codex");
    assert.equal(isError, true);
    assert.match(payload.error, /claude starts a plan council/);
    assert.match(payload.error, /do not guess at a plan file/);
  });

  test("the author opens it and the critic moves first", async () => {
    const { payload } = await open(claude, "claude");
    assert.equal(payload.ok, true);
    assert.equal(payload.your_role, "author");
    assert.equal(payload.phase, "critique");
    assert.equal(payload.next_actor, "codex");
    assert.equal(payload.max_rounds, 10);
    assert.match(payload.goal_id, /^\d{4}-\d{2}-\d{2}-plan-/);
    assert.match(payload.next_step, /Waiting on codex to critique/);
    goalId = payload.goal_id;
  });

  test("the author can tell the critic has not arrived yet", async () => {
    const { payload } = await call(claude, "plan_council_open", { agent: "claude" });
    assert.deepEqual(payload.participants, ["claude"]);
    assert.equal(payload.peer_joined, false);
    assert.match(payload.next_step, /codex has not joined yet/);
  });

  test("the critic joins it rather than starting another, and is told what to run", async () => {
    const { payload } = await open(codex, "codex");
    assert.equal(payload.goal_id, goalId);
    assert.equal(payload.your_role, "critic");
    assert.equal(payload.peer_joined, true);
    assert.deepEqual(payload.participants, ["claude", "codex"]);
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
    // The loop only adds; the author is told to keep each fix as small as it can be.
    assert.match(waited.payload.instruction, /smallest change that settles it/);
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

// The ratchet. A real five-round council applied 19 findings and rejected none, and the
// plan grew from 154 lines to 332 — because applying a finding means adding text, and
// nothing in the loop ever takes any out. Past the gate a Medium buys no readiness, so
// the length it costs is pure loss.
describe("Medium and Low findings past the severity gate", () => {
  let root, claude, codex, goalId;

  // A Blocker keeps the council alive past the gate; the Mediums ride along with it. This
  // mixed shape is the only one the rule ever sees — a gate-round critique with no Blocker
  // and no High is already `ready`, and never reaches a resolve.
  const mixed = critique({
    critique:
      "**Needs Fix**\n- [Blocker] The migration has no rollback. Fix: add one.\n" +
      "- [Medium] The error message could name the field.\n" +
      "- [Low] Two headings disagree on tense.",
    blockers: 1,
    mediums: 1,
    lows: 1,
  });

  /** One full round on a Blocker-only critique, which needs no account of anything. */
  const advance = async () => {
    await call(codex, "plan_council_critique", { goal_id: goalId, agent: "codex", ...critique() });
    await call(claude, "plan_council_resolve", {
      goal_id: goalId,
      agent: "claude",
      ...resolution(),
    });
  };

  before(async () => {
    root = makeRoot("plan-deferred");
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

  test("rounds 1 and 2 take a resolve with no account of them", async () => {
    await call(codex, "plan_council_critique", { goal_id: goalId, agent: "codex", ...mixed });
    const { payload, isError } = await call(claude, "plan_council_resolve", {
      goal_id: goalId,
      agent: "claude",
      ...resolution(),
    });
    assert.equal(isError, false);
    assert.equal(payload.round, 2);
  });

  test("from round 3 a resolve that ignores them is refused", async () => {
    await advance();
    await call(codex, "plan_council_critique", { goal_id: goalId, agent: "codex", ...mixed });

    const refused = await call(claude, "plan_council_resolve", {
      goal_id: goalId,
      agent: "claude",
      ...resolution(),
    });
    assert.equal(refused.isError, true);
    assert.match(refused.payload.error, /deferred/);
    assert.match(refused.payload.error, /2 Medium\/Low finding/);
  });

  test("deferring them by name is accepted, and reaches the record", async () => {
    const { payload, isError } = await call(claude, "plan_council_resolve", {
      goal_id: goalId,
      agent: "claude",
      ...resolution({
        deferred: "M1 (error wording) and L1 (heading tense) both deferred — neither blocks.",
      }),
    });
    assert.equal(isError, false);
    assert.equal(payload.round, 4);

    const step = readFileSync(join(root, goalId, "r3-resolve-6.md"), "utf8");
    assert.match(step, /Medium\/Low findings deferred/);
    assert.match(step, /heading tense/);
  });

  test("a critique with no Medium or Low needs no account of them", async () => {
    await call(codex, "plan_council_critique", { goal_id: goalId, agent: "codex", ...critique() });
    const { payload, isError } = await call(claude, "plan_council_resolve", {
      goal_id: goalId,
      agent: "claude",
      ...resolution(),
    });
    assert.equal(isError, false);
    assert.equal(payload.round, 5);
  });
});

// The failure this exists for: a six-round, sixty-five-minute council on a plan whose round-1
// critique carried 1 Blocker and 8 Highs, four of which were unmade design decisions rather
// than defects. The author guessed at all four, and every guess produced the next round's
// findings. Severity says how bad; it never said whose problem it was.
describe("findings that are the user's to decide, not the author's to fix", () => {
  let root, claude, codex, goalId;

  const withDecisions = (over = {}) =>
    critique({
      critique:
        "**Needs Fix**\n- [Blocker] Step 3 runs before Step 2 commits. Fix: reorder.\n" +
        "- [High] The plan never says which statistic the 5% win uses.",
      blockers: 1,
      highs: 1,
      decisions: 1,
      decision_list:
        "1. Which statistic decides the 5% win — the median across runs, or a confidence " +
        "bound against pre_accel_fp8? Both are defensible; the plan assumes neither.",
      ...over,
    });

  before(async () => {
    root = makeRoot("plan-decisions");
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

  test("a decision parks the council instead of handing the round to the author", async () => {
    const { payload } = await call(codex, "plan_council_critique", {
      goal_id: goalId,
      agent: "codex",
      ...withDecisions(),
    });
    assert.equal(payload.phase, "user");
    assert.equal(payload.status, "needs_user");
    assert.match(payload.stop_reason, /1 decision\(s\) that are the user's to make/);
    assert.equal(payload.latest_critique.decisions, 1);
    assert.match(payload.latest_critique.decision_list, /confidence bound/);
  });

  test("the author is told to show the questions, not answer them", async () => {
    const { payload } = await call(claude, "plan_council_await", {
      goal_id: goalId,
      agent: "claude",
    });
    assert.equal(payload.retry, false);
    assert.match(payload.next_step, /answer none of them yourself/);
    assert.match(payload.next_step, /decision_list/);
  });

  test("resuming hands the same round back to the author", async () => {
    const { payload } = await call(claude, "plan_council_resume", {
      goal_id: goalId,
      agent: "claude",
      decision: "Use a confidence bound against pre_accel_fp8. The median is not enough.",
    });
    assert.equal(payload.phase, "resolve");
    assert.equal(payload.next_actor, "claude");
    assert.equal(payload.round, 1);

    const step = readFileSync(join(root, goalId, "r1-critique-1.md"), "utf8");
    assert.match(step, /1 of them the user's to decide/);
    assert.match(step, /Decisions for the user/);
  });

});

// The rules that keep `decisions` from becoming a way to hand back work rather than a way to
// route it. Its own council, because these fire on the critic's turn.
describe("what the server refuses to accept as a decision", () => {
  let root, claude, codex, goalId;

  before(async () => {
    root = makeRoot("plan-decision-rules");
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

  test("a count with no questions written down is refused", async () => {
    const { payload, isError } = await call(codex, "plan_council_critique", {
      goal_id: goalId,
      agent: "codex",
      ...critique({ decisions: 1 }),
    });
    assert.equal(isError, true);
    assert.match(payload.error, /none written down/);
  });

  test("questions with no count are refused", async () => {
    const { payload, isError } = await call(codex, "plan_council_critique", {
      goal_id: goalId,
      agent: "codex",
      ...critique({ decision_list: "Median or confidence bound?" }),
    });
    assert.equal(isError, true);
    assert.match(payload.error, /decisions is 0/);
  });

  test("more decisions than blocking findings is refused", async () => {
    const { payload, isError } = await call(codex, "plan_council_critique", {
      goal_id: goalId,
      agent: "codex",
      ...critique({ blockers: 1, highs: 0, decisions: 3, decision_list: "a? b? c?" }),
    });
    assert.equal(isError, true);
    assert.match(payload.error, /cannot exceed the 1 Blocker and High/);
  });

  // The severity gate retires Mediums; it must never retire a decision. Nothing the author
  // can do makes an unmade decision go away, so it cannot age into readiness.
  test("a decision outstanding is never ready, whatever the round", async () => {
    const { payload } = await call(codex, "plan_council_critique", {
      goal_id: goalId,
      agent: "codex",
      ...critique({
        blockers: 0,
        highs: 1,
        decisions: 1,
        decision_list: "Median across runs, or a confidence bound? Both are defensible.",
      }),
    });
    assert.equal(payload.status, "needs_user");
    assert.equal(payload.phase, "user");
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

// A peer that has not been triggered yet is a not-yet, not a failure. The second real run
// errored a council the user was about to complete, which then let the critic invent a
// second one.
describe("a peer that has not joined yet", () => {
  let root, claude, codex, goalId;

  before(async () => {
    root = makeRoot("plan-nojoin");
    process.env.COUNCIL_PLAN_JOIN_WAIT_MS = "1";
    claude = await connect("claude", root);
    codex = await connect("codex", root);
    goalId = (await open(claude, "claude")).payload.goal_id;
  });

  after(async () => {
    delete process.env.COUNCIL_PLAN_JOIN_WAIT_MS;
    await claude?.close();
    await codex?.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("hands back to the user without destroying the council", async () => {
    const { payload } = await call(claude, "plan_council_await", { goal_id: goalId, agent: "claude" });
    assert.equal(payload.retry, false);
    assert.equal(payload.status, "active", "a council nobody joined yet must stay open");
    assert.equal(payload.peer_joined, false);
    assert.match(payload.note, /has not joined after/);
    assert.match(payload.note, /this council stays open/);
  });

  test("and the peer can still join the same council afterwards", async () => {
    const { payload } = await open(codex, "codex");
    assert.equal(payload.goal_id, goalId, "must join, not start a second one");
    assert.equal(payload.peer_joined, true);
    assert.equal(payload.next_step, "Critique the plan for round 1 with plan_council_critique.");
  });
});

// The council created in one session and picked up in the next: old by the clock, new by
// the work. Measuring the wait from started_at made the first await fail instantly, without
// waiting at all, and then report a five-minute wait that never happened.
describe("a council picked up in a later session", () => {
  let root, claude, codex, goalId;
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));

  before(async () => {
    root = makeRoot("plan-rejoin");
    // Long enough that the council goes stale during this test, short enough to run. The
    // poll budget stays under the step budget so one await call cannot outlive it.
    process.env.COUNCIL_PLAN_STEP_WAIT_MS = "400";
    process.env.COUNCIL_POLL_BUDGET_MS = "200";
    claude = await connect("claude", root);
    codex = await connect("codex", root);
    goalId = (await open(claude, "claude")).payload.goal_id;
  });

  after(async () => {
    delete process.env.COUNCIL_PLAN_STEP_WAIT_MS;
    delete process.env.COUNCIL_POLL_BUDGET_MS;
    await claude?.close();
    await codex?.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("the wait runs from the latest sign of life, not from creation", async () => {
    // The council is now older than the whole step budget — as it was on the second real
    // run, where 32 minutes had passed since a council opened in an earlier session.
    await pause(600);

    // codex arriving is a sign of life. Measured from creation this council is long past
    // its budget; measured from the join it has barely started.
    await open(codex, "codex");
    const { payload } = await call(claude, "plan_council_await", {
      goal_id: goalId,
      agent: "claude",
    });
    assert.equal(payload.status, "active", "a council just re-joined must not be errored");
    assert.equal(payload.peer_joined, true);
    assert.equal(payload.retry, true);
  });
});

// The first real run: Codex joined and spent minutes reading the plan against the codebase.
// On one shared five-minute budget the server would have killed a healthy council mid-
// critique and thrown that work away. A joined peer gets the long budget.
describe("a joined peer that is still working", () => {
  let root, claude, codex, goalId;

  before(async () => {
    root = makeRoot("plan-working");
    // The join budget is expired from the start. It must not apply once codex is present.
    process.env.COUNCIL_PLAN_JOIN_WAIT_MS = "1";
    claude = await connect("claude", root);
    codex = await connect("codex", root);
    goalId = (await open(claude, "claude")).payload.goal_id;
    await open(codex, "codex");
  });

  after(async () => {
    delete process.env.COUNCIL_PLAN_JOIN_WAIT_MS;
    await claude?.close();
    await codex?.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("is not timed out, and the author is told to keep waiting", async () => {
    const { payload } = await call(claude, "plan_council_await", { goal_id: goalId, agent: "claude" });
    assert.equal(payload.status, "active", "a working peer must not be errored");
    assert.equal(payload.retry, true);
    assert.equal(payload.peer_joined, true);
    assert.match(payload.note, /keep calling while it answers retry:true/);
    assert.match(payload.note, /do not decide the peer is absent/);
    assert.match(payload.note, /codex has joined and is working/);
    assert.ok(payload.minutes_left > 0);
  });
});

describe("a joined peer that goes silent", () => {
  let root, claude, codex, goalId;

  before(async () => {
    root = makeRoot("plan-silent");
    process.env.COUNCIL_PLAN_STEP_WAIT_MS = "1";
    claude = await connect("claude", root);
    codex = await connect("codex", root);
    goalId = (await open(claude, "claude")).payload.goal_id;
    await open(codex, "codex");
  });

  after(async () => {
    delete process.env.COUNCIL_PLAN_STEP_WAIT_MS;
    await claude?.close();
    await codex?.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("eventually times out, saying it joined rather than never came", async () => {
    const { payload } = await call(claude, "plan_council_await", { goal_id: goalId, agent: "claude" });
    assert.equal(payload.retry, false);
    assert.equal(payload.status, "error");
    assert.match(payload.stop_reason, /codex joined but did not critique round 1/);
    assert.match(payload.note, /plan file keeps every fix applied/);
  });
});

// Starting a run clears what a dead session left behind. Every run of this so far was
// derailed by leftovers, because one user drives both windows by hand and the previous
// session's council is the normal state of the database, not an edge case.
describe("starting a run clears stale leftovers", () => {
  let root, claude, codex;
  // The threshold is 1ms here, so anything left over needs to be measurably older than the
  // call that sweeps it.
  const age = () => new Promise((r) => setTimeout(r, 30));

  before(async () => {
    root = makeRoot("plan-sweep");
    process.env.COUNCIL_STALE_AFTER_MS = "1";
    claude = await connect("claude", root);
    codex = await connect("codex", root);
  });

  after(async () => {
    delete process.env.COUNCIL_STALE_AFTER_MS;
    await claude?.close();
    await codex?.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("a stale plan council on another plan is cleared and reported", async () => {
    const old = await open(claude, "claude", { plan_path: "/proj/docs/old.md" });
    await age();
    const fresh = await open(claude, "claude", { plan_path: "/proj/docs/new.md" });

    assert.notEqual(fresh.payload.goal_id, old.payload.goal_id);
    assert.equal(fresh.payload.plan_path, "/proj/docs/new.md");
    assert.equal(fresh.payload.cleared.length, 1);
    assert.equal(fresh.payload.cleared[0].goal_id, old.payload.goal_id);
    assert.equal(fresh.payload.cleared[0].mode, "plan_council");
    assert.equal(fresh.payload.cleared[0].plan_path, "/proj/docs/old.md");
  });

  // Resuming yesterday's work is the case that must never be swept, however old it is.
  test("a council on the same plan is resumed, not cleared", async () => {
    await age();
    const again = await open(claude, "claude", { plan_path: "/proj/docs/new.md" });
    assert.equal(again.payload.plan_path, "/proj/docs/new.md");
    assert.equal(again.payload.cleared, undefined);
    assert.equal(again.payload.status, "active");
  });

  test("the critic never sweeps, even holding a plan path", async () => {
    const { payload } = await open(codex, "codex", { plan_path: "/proj/docs/other.md" });
    assert.equal(payload.plan_path, "/proj/docs/new.md", "joins what the author opened");
    assert.equal(payload.cleared, undefined);
  });

  test("a stale debate council is cleared too, so it stops blocking", async () => {
    await call(claude, "council_abandon", { agent: "claude", reason: "clear the plan council" });
    const debate = await call(claude, "council_open", {
      agent: "claude",
      question: "A council nobody finished",
      project_path: "/proj",
    });
    await call(claude, "council_submit", {
      goal_id: debate.payload.goal_id,
      agent: "claude",
      ...entry(),
    });
    await age();

    const { payload } = await open(claude, "claude", { plan_path: "/proj/docs/after.md" });
    assert.equal(payload.status, "active");
    assert.equal(payload.cleared.length, 1);
    assert.equal(payload.cleared[0].mode, "council");
    assert.equal(payload.cleared[0].goal_id, debate.payload.goal_id);
    await call(claude, "council_abandon", { agent: "claude", reason: "cleanup" });
  });
});

describe("a recent council is never swept", () => {
  let root, claude;

  before(async () => {
    root = makeRoot("plan-nosweep");
    // The default 15-minute threshold: nothing in this test is old enough to clear.
    claude = await connect("claude", root);
  });

  after(async () => {
    await claude?.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("it blocks instead, because the peer may be mid-turn", async () => {
    const first = await open(claude, "claude", { plan_path: "/proj/docs/live.md" });
    const second = await open(claude, "claude", { plan_path: "/proj/docs/different.md" });

    assert.equal(second.payload.goal_id, first.payload.goal_id, "must not start a second");
    assert.equal(second.payload.cleared, undefined);
    assert.match(second.payload.warning, /you asked for \/proj\/docs\/different\.md/);
  });
});

// Picking up existing work is the user's call, not the model's: resuming silently confuses,
// and starting over silently throws away a critique the peer paid real time for.
describe("resuming an existing council", () => {
  let root, claude, codex, goalId, planFile;

  before(async () => {
    root = makeRoot("plan-resume");
    mkdirSync(root, { recursive: true });
    planFile = join(root, "the-plan.md");
    writeFileSync(planFile, "# Plan\n\nStep one.\n");

    claude = await connect("claude", root);
    codex = await connect("codex", root);
    goalId = (await open(claude, "claude", { plan_path: planFile })).payload.goal_id;
    await open(codex, "codex", { plan_path: planFile });
    await call(codex, "plan_council_critique", { goal_id: goalId, agent: "codex", ...critique() });
  });

  after(async () => {
    await claude?.close();
    await codex?.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("the author is told to stop and ask, not to act", async () => {
    const { payload } = await open(claude, "claude", { plan_path: planFile });
    assert.equal(payload.goal_id, goalId);
    assert.equal(payload.resuming.round, 1);
    assert.equal(payload.resuming.phase, "resolve");
    assert.equal(payload.resuming.waiting_critique, "1 Blocker, 0 High, 0 Medium, 0 Low — Not ready");
    assert.equal(payload.resuming.plan_changed_since_critique, false);
    assert.match(payload.next_step, /Stop\. Do not resolve or critique anything yet/);
    assert.equal(payload.instruction, undefined, "no contradictory order to run the resolver");
  });

  // The loop only ever adds, over ten rounds, so a plan can swell into a specification
  // without anyone noticing. One real run reached 1797 lines that way.
  test("the plan's size and growth are reported every round", async () => {
    const before = await open(claude, "claude", { plan_path: planFile });
    assert.equal(before.payload.plan_lines, 4);

    writeFileSync(planFile, "# Plan\n" + "\nA new step.\n".repeat(20));
    const { payload } = await call(claude, "plan_council_resolve", {
      goal_id: goalId,
      agent: "claude",
      ...resolution(),
    });
    assert.equal(payload.plan_lines, 42);
    assert.equal(payload.plan_lines_added_last_step, 38, "growth since the critique");
    assert.equal(payload.plan_lines_added_total, 38);
  });

  test("a plan rewritten since the critique is called out", async () => {
    writeFileSync(planFile, "# Plan\n\nA completely different step one.\n");
    const { payload } = await open(claude, "claude", { plan_path: planFile });
    assert.equal(payload.resuming.plan_changed_since_critique, true);
    assert.match(payload.next_step, /plan file HAS changed since that critique/);
  });

  test("the critic is not asked — it just joins and works", async () => {
    const { payload } = await open(codex, "codex", { plan_path: planFile });
    assert.equal(payload.resuming, undefined);
    assert.equal(payload.goal_id, goalId);
  });

  test("fresh discards it and starts again at round 1", async () => {
    const { payload } = await open(claude, "claude", { plan_path: planFile, fresh: true });
    assert.notEqual(payload.goal_id, goalId, "a new council, not the old one");
    assert.equal(payload.round, 1);
    assert.equal(payload.critiques_so_far, 0);
    assert.equal(payload.resuming, undefined);
    assert.equal(payload.cleared.length, 1);
    assert.equal(payload.cleared[0].goal_id, goalId);
  });

  test("a council with nothing in it resumes without asking", async () => {
    const { payload } = await open(claude, "claude", { plan_path: planFile });
    assert.equal(payload.resuming, undefined, "nothing at stake, nothing to ask about");
    assert.equal(payload.critiques_so_far, 0);
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
    assert.match(payload.note, /any mode/);

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
