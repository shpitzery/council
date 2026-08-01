import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { validateSubmission, evaluateStopRules, ValidationError } from "../src/rules.js";

const council = (over = {}) => ({
  goal_id: "g1",
  question: "q",
  round: 2,
  max_rounds: 3,
  status: "active",
  ...over,
});

const entry = (over = {}) => ({
  agent: "claude",
  round: 2,
  position: "Fix the cache key.",
  reasoning: ["Key omits the tenant id."],
  evidence: ["src/cache/keys.py:41"],
  verdict_on_peer: "AGREE",
  new_arguments: true,
  confidence: "high",
  ...over,
});

describe("validateSubmission", () => {
  test("accepts a well-formed entry", () => {
    const clean = validateSubmission(entry(), council(), true);
    assert.equal(clean.position, "Fix the cache key.");
    assert.equal(clean.verdict_on_peer, "AGREE");
  });

  test("rejects DISAGREE with no disagreement quoted", () => {
    assert.throws(
      () => validateSubmission(entry({ verdict_on_peer: "DISAGREE" }), council(), true),
      (e) => e instanceof ValidationError && e.field === "disagreement",
    );
  });

  test("rejects UNRESOLVED with no settling test", () => {
    assert.throws(
      () => validateSubmission(entry({ verdict_on_peer: "UNRESOLVED" }), council(), true),
      (e) => e instanceof ValidationError && e.field === "settling_test",
    );
  });

  test("rejects a verdict on round 1 — the peer cannot have been seen yet", () => {
    assert.throws(
      () => validateSubmission(entry({ round: 1 }), council({ round: 1 }), true),
      (e) => e.field === "verdict_on_peer",
    );
  });

  test("requires a verdict after round 1", () => {
    assert.throws(
      () => validateSubmission(entry({ verdict_on_peer: null }), council(), true),
      (e) => e.field === "verdict_on_peer",
    );
  });

  test("rejects a round that is not the council's current round", () => {
    assert.throws(
      () => validateSubmission(entry({ round: 5 }), council(), true),
      (e) => e.field === "round",
    );
  });

  test("rejects a non-participant", () => {
    assert.throws(() => validateSubmission(entry(), council(), false), (e) => e.field === "agent");
  });

  test("rejects submission to a council that is not active", () => {
    assert.throws(
      () => validateSubmission(entry(), council({ status: "aborted" }), true),
      (e) => e.field === "status",
    );
  });

  test("enforces length caps", () => {
    assert.throws(
      () => validateSubmission(entry({ reasoning: ["a", "b", "c", "d", "e"] }), council(), true),
      (e) => e.field === "reasoning",
    );
    assert.throws(
      () => validateSubmission(entry({ position: "x".repeat(400) }), council(), true),
      (e) => e.field === "position",
    );
  });
});

describe("evaluateStopRules", () => {
  const pair = (round, over = {}) => [
    { agent: "claude", round, verdict_on_peer: "DISAGREE", new_arguments: true, ...over },
    { agent: "codex", round, verdict_on_peer: "DISAGREE", new_arguments: true, ...over },
  ];

  test("rule 5: a non-active status stops immediately", () => {
    const r = evaluateStopRules(council({ status: "aborted" }), [], []);
    assert.equal(r.stop, true);
    assert.equal(r.status, "aborted");
  });

  test("carries on when only one side has submitted this round", () => {
    const all = [pair(2)[0]];
    assert.equal(evaluateStopRules(council(), all, all).stop, false);
  });

  test("rule 1: the round cap fires even while both sides still disagree", () => {
    const all = [...pair(1), ...pair(2), ...pair(3)];
    const r = evaluateStopRules(council({ round: 3 }), [], all);
    assert.equal(r.stop, true);
    assert.equal(r.status, "capped");
    assert.match(r.reason, /max_rounds/);
  });

  test("rule 2: both reporting AGREE converges", () => {
    const all = [...pair(1), ...pair(2, { verdict_on_peer: "AGREE" })];
    const r = evaluateStopRules(council(), [], all);
    assert.equal(r.stop, true);
    assert.equal(r.status, "converged");
    assert.match(r.reason, /AGREE/);
  });

  test("rule 3: no new arguments from either side converges", () => {
    const all = [...pair(1), ...pair(2, { new_arguments: false })];
    const r = evaluateStopRules(council(), [], all);
    assert.equal(r.stop, true);
    assert.equal(r.status, "converged");
    assert.match(r.reason, /new argument/);
  });

  test("rule 4: the same agent stuck on UNRESOLVED twice hands back to the user", () => {
    const all = [
      { agent: "claude", round: 1, verdict_on_peer: "UNRESOLVED", new_arguments: true },
      { agent: "codex", round: 1, verdict_on_peer: "DISAGREE", new_arguments: true },
      { agent: "claude", round: 2, verdict_on_peer: "UNRESOLVED", new_arguments: true },
      { agent: "codex", round: 2, verdict_on_peer: "DISAGREE", new_arguments: true },
    ];
    const r = evaluateStopRules(council(), [], all);
    assert.equal(r.stop, true);
    assert.equal(r.status, "capped");
    assert.match(r.reason, /claude.*UNRESOLVED/);
  });

  test("a live disagreement below the cap keeps going", () => {
    const all = [...pair(1), ...pair(2)];
    assert.equal(evaluateStopRules(council(), [], all).stop, false);
  });
});
