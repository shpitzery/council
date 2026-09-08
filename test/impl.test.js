// The implementation council: the write/verify loop, the approvals it refuses, and the
// three-way guard. The refusals are the interesting part — each one is a way an approval
// could mean less than it appears to.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { makeRoot, connect, call, entry } from "./harness.js";

/** A throwaway git repo, because this mode measures its work as a diff from a base commit. */
function makeRepo(name) {
  const dir = join("/tmp", `council-repo-${name}-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(dir, "app.js"), "export const one = 1;\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  return dir;
}

const report = (over = {}) => ({
  summary: "Added `two` to app.js and exported it.",
  applied: "None.",
  rejected: "None.",
  ...over,
});

const review = (over = {}) => ({
  findings: "- [High] `two` is not covered by a test. Fix: add one.",
  blockers: 0,
  highs: 1,
  mediums: 0,
  lows: 0,
  verification: "Ran `node --check app.js`; parses. Read the two call sites of `one`.",
  report_matches_diff: "yes",
  verdict: "Changes needed",
  ...over,
});

const approval = (over = {}) =>
  review({
    findings: "No blocking findings.",
    highs: 0,
    verdict: "Approve",
    ...over,
  });

describe("an implementation council, end to end", () => {
  let root, repo, claude, codex, goalId;

  before(async () => {
    root = makeRoot("impl-e2e");
    repo = makeRepo("e2e");
    claude = await connect("claude", root);
    codex = await connect("codex", root);
  });

  after(async () => {
    await claude?.close();
    await codex?.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  test("the critic cannot start one — only the author knows what was asked", async () => {
    const { payload, isError } = await call(codex, "impl_council_open", {
      agent: "codex",
      task: "add two",
      project_path: repo,
    });
    assert.equal(isError, true);
    assert.match(payload.error, /claude starts an implementation council/);
  });

  test("the author opens it and moves first, with the base commit recorded", async () => {
    const { payload } = await call(claude, "impl_council_open", {
      agent: "claude",
      task: "add two to app.js",
      project_path: repo,
    });
    assert.equal(payload.your_role, "author");
    assert.equal(payload.phase, "report", "nothing to verify until the code exists");
    assert.equal(payload.next_actor, "claude");
    assert.match(payload.base_ref, /^[0-9a-f]{40}$/);
    assert.equal(payload.dirty_at_open, false);
    assert.equal(payload.diff_lines, 0, "nothing changed yet");
    goalId = payload.goal_id;
  });

  test("opening outside a git repository is refused, with the reason", async () => {
    const other = makeRoot("impl-nogit");
    const c2 = await connect("claude", other);
    const { payload, isError } = await call(c2, "impl_council_open", {
      agent: "claude",
      task: "somewhere with no git",
      project_path: "/tmp",
    });
    assert.equal(isError, true);
    assert.match(payload.error, /not a git repository|measures the change as a diff/);
    await c2.close();
    rmSync(other, { recursive: true, force: true });
  });

  test("the critic cannot report and the author cannot review", async () => {
    const wrong = await call(codex, "impl_council_report", {
      goal_id: goalId,
      agent: "codex",
      ...report(),
    });
    assert.equal(wrong.isError, true);
    assert.match(wrong.payload.error, /claude implements/);

    const other = await call(claude, "impl_council_review", {
      goal_id: goalId,
      agent: "claude",
      ...review(),
    });
    assert.equal(other.isError, true);
    assert.match(other.payload.error, /codex verifies/);
  });

  test("the server measures the diff itself, not the author's account of it", async () => {
    writeFileSync(join(repo, "app.js"), "export const one = 1;\nexport const two = 2;\n");
    await call(codex, "impl_council_open", { agent: "codex" });

    const { payload } = await call(claude, "impl_council_report", {
      goal_id: goalId,
      agent: "claude",
      ...report(),
    });
    assert.equal(payload.phase, "review");
    assert.equal(payload.next_actor, "codex");
    assert.ok(payload.diff_lines > 0, "the server sees the change on disk");
  });

  test("the critic sees the report and its instruction", async () => {
    const { payload } = await call(codex, "impl_council_await", {
      goal_id: goalId,
      agent: "codex",
    });
    assert.equal(payload.arrived, true);
    assert.match(payload.latest_report.summary, /Added `two`/);
    assert.match(payload.instruction, /verify-implementation/);
    assert.match(payload.instruction, /Never edit the code/);
  });

  test("a review hands the round back and starts the next one", async () => {
    const { payload } = await call(codex, "impl_council_review", {
      goal_id: goalId,
      agent: "codex",
      ...review(),
    });
    assert.equal(payload.phase, "report");
    assert.equal(payload.next_actor, "claude");
    assert.equal(payload.round, 2);
  });

  test("approval ends it, and the trail records what was verified", async () => {
    await call(claude, "impl_council_report", {
      goal_id: goalId,
      agent: "claude",
      ...report({ summary: "Added a test for `two`.", applied: "Added the missing test." }),
    });
    const { payload } = await call(codex, "impl_council_review", {
      goal_id: goalId,
      agent: "codex",
      ...approval({ verification: "Ran the new test; it passes and fails when `two` is removed." }),
    });
    assert.equal(payload.status, "ready");
    assert.match(payload.stop_reason, /the critic approved/);

    const closed = await call(claude, "impl_council_close", { goal_id: goalId, agent: "claude" });
    assert.match(closed.payload.summary, /Approved on this evidence/);
    assert.match(closed.payload.summary, /fails when `two` is removed/);

    const trail = readFileSync(join(root, goalId, "trail.md"), "utf8");
    assert.match(trail, /Round 1 — implementation by claude/);
    assert.match(trail, /Round 1 — verification by codex/);
    assert.match(trail, /What was verified/);
  });
});

// Each of these is a way an approval could mean less than it looks. The mode is only worth
// running if every one of them is refused.
describe("what an approval is refused for", () => {
  let root, repo, claude, codex, goalId, planFile;

  before(async () => {
    root = makeRoot("impl-refuse");
    repo = makeRepo("refuse");
    planFile = join(repo, "PLAN.md");
    writeFileSync(planFile, "# Plan\n\n- W1: add two\n- W2: add three\n");
    claude = await connect("claude", root);
    codex = await connect("codex", root);
    const opened = await call(claude, "impl_council_open", {
      agent: "claude",
      task: "implement W1",
      project_path: repo,
      plan_path: planFile,
      plan_scope: "W1 only",
    });
    goalId = opened.payload.goal_id;
    await call(codex, "impl_council_open", { agent: "codex" });
    await call(claude, "impl_council_report", { goal_id: goalId, agent: "claude", ...report() });
  });

  after(async () => {
    await claude?.close();
    await codex?.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  const attempt = (over) =>
    call(codex, "impl_council_review", { goal_id: goalId, agent: "codex", ...approval(over) });

  test("Blocker or High findings", async () => {
    const { payload, isError } = await attempt({ blockers: 1 });
    assert.equal(isError, true);
    assert.match(payload.error, /cannot Approve with 1 Blocker/);
  });

  test("scope left unimplemented", async () => {
    const { payload, isError } = await attempt({ gaps: 1, coverage: "W1 is missing entirely." });
    assert.equal(isError, true);
    assert.match(payload.error, /unimplemented/);
    assert.match(payload.error, /at any round/);
  });

  test("no evidence of what was checked", async () => {
    const { payload, isError } = await attempt({ verification: "   " });
    assert.equal(isError, true);
    assert.equal(payload.field, "verification");
  });

  test("a report that does not match the diff", async () => {
    const { payload, isError } = await attempt({
      report_matches_diff: "no",
      mismatch: "The diff also rewrites README.md, which the report never mentions.",
    });
    assert.equal(isError, true);
    assert.match(payload.error, /does not match the diff/);
  });

  test("a mismatch with nothing said about it", async () => {
    const { payload, isError } = await attempt({ report_matches_diff: "no" });
    assert.equal(isError, true);
    assert.equal(payload.field, "mismatch");
  });

  test("gaps counted with no plan to be incomplete against", async () => {
    const other = makeRoot("impl-noplan");
    const otherRepo = makeRepo("noplan");
    const c2 = await connect("claude", other);
    const x2 = await connect("codex", other);
    const id = (
      await call(c2, "impl_council_open", { agent: "claude", task: "no plan here", project_path: otherRepo })
    ).payload.goal_id;
    await call(x2, "impl_council_open", { agent: "codex" });
    await call(c2, "impl_council_report", { goal_id: id, agent: "claude", ...report() });

    const { payload, isError } = await call(x2, "impl_council_review", {
      goal_id: id,
      agent: "codex",
      ...review({ gaps: 2 }),
    });
    assert.equal(isError, true);
    assert.equal(payload.field, "gaps");

    await c2.close();
    await x2.close();
    rmSync(other, { recursive: true, force: true });
    rmSync(otherRepo, { recursive: true, force: true });
  });

  test("gaps with no account of what is missing", async () => {
    const { payload, isError } = await call(codex, "impl_council_review", {
      goal_id: goalId,
      agent: "codex",
      ...review({ gaps: 1 }),
    });
    assert.equal(isError, true);
    assert.equal(payload.field, "coverage");
  });

  test("and a clean approval still goes through", async () => {
    const { payload } = await attempt({ gaps: 0, coverage: "W1 done; W2 out of scope." });
    assert.equal(payload.status, "ready");
  });
});

// Medium findings stop blocking at round 3, because a thorough reviewer finds new ones
// forever. An unimplemented plan step is not a judgement about quality, so it never stops.
describe("the severity gate, and what it does not cover", () => {
  let root, repo, claude, codex, goalId, planFile;

  before(async () => {
    root = makeRoot("impl-gate");
    repo = makeRepo("gate");
    planFile = join(repo, "PLAN.md");
    writeFileSync(planFile, "# Plan\n\n- W1: add two\n");
    claude = await connect("claude", root);
    codex = await connect("codex", root);
    goalId = (
      await call(claude, "impl_council_open", {
        agent: "claude",
        task: "implement W1",
        project_path: repo,
        plan_path: planFile,
        plan_scope: "W1",
      })
    ).payload.goal_id;
    await call(codex, "impl_council_open", { agent: "codex" });
  });

  after(async () => {
    await claude?.close();
    await codex?.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  test("a gap blocks approval at round 3, where a Medium would not", async () => {
    for (const round of [1, 2]) {
      await call(claude, "impl_council_report", { goal_id: goalId, agent: "claude", ...report() });
      const r = await call(codex, "impl_council_review", {
        goal_id: goalId,
        agent: "codex",
        ...review({ highs: 0, mediums: 2 }),
      });
      assert.equal(r.payload.round, round + 1);
    }

    await call(claude, "impl_council_report", { goal_id: goalId, agent: "claude", ...report() });

    // Round 3, Mediums outstanding: approval is allowed.
    const withMediums = await call(codex, "impl_council_review", {
      goal_id: goalId,
      agent: "codex",
      ...approval({ mediums: 2, gaps: 0, coverage: "W1 done." }),
    });
    assert.equal(withMediums.payload.status, "ready", "Medium does not block from round 3");
  });

  test("but the same round with a gap is refused", async () => {
    const other = makeRoot("impl-gate2");
    const otherRepo = makeRepo("gate2");
    const plan = join(otherRepo, "PLAN.md");
    writeFileSync(plan, "# Plan\n\n- W1: add two\n");
    const c2 = await connect("claude", other);
    const x2 = await connect("codex", other);
    const id = (
      await call(c2, "impl_council_open", {
        agent: "claude",
        task: "implement W1",
        project_path: otherRepo,
        plan_path: plan,
        plan_scope: "W1",
      })
    ).payload.goal_id;
    await call(x2, "impl_council_open", { agent: "codex" });

    for (const _ of [1, 2]) {
      await call(c2, "impl_council_report", { goal_id: id, agent: "claude", ...report() });
      await call(x2, "impl_council_review", { goal_id: id, agent: "codex", ...review({ highs: 0, mediums: 1 }) });
    }
    await call(c2, "impl_council_report", { goal_id: id, agent: "claude", ...report() });

    const { payload, isError } = await call(x2, "impl_council_review", {
      goal_id: id,
      agent: "codex",
      ...approval({ mediums: 1, gaps: 1, coverage: "W1 is still not done." }),
    });
    assert.equal(isError, true, "a gap blocks at every round");
    assert.match(payload.error, /at any round/);

    await c2.close();
    await x2.close();
    rmSync(other, { recursive: true, force: true });
    rmSync(otherRepo, { recursive: true, force: true });
  });
});

describe("questions that are the user's", () => {
  let root, repo, claude, codex, goalId, planFile;

  before(async () => {
    root = makeRoot("impl-park");
    repo = makeRepo("park");
    planFile = join(repo, "PLAN.md");
    writeFileSync(planFile, "# Plan\n\n- W1: add two\n");
    claude = await connect("claude", root);
    codex = await connect("codex", root);
    goalId = (
      await call(claude, "impl_council_open", {
        agent: "claude",
        task: "implement W1",
        project_path: repo,
        plan_path: planFile,
      })
    ).payload.goal_id;
    await call(codex, "impl_council_open", { agent: "codex" });
  });

  after(async () => {
    await claude?.close();
    await codex?.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  test("a defect in the plan parks the council rather than reopening the plan", async () => {
    await call(claude, "impl_council_report", { goal_id: goalId, agent: "claude", ...report() });
    const { payload } = await call(codex, "impl_council_review", {
      goal_id: goalId,
      agent: "codex",
      ...review({ plan_defect: "W1 says export `two` from app.js, but app.js is generated." }),
    });
    assert.equal(payload.status, "needs_user");
    assert.equal(payload.phase, "user");
    assert.match(payload.stop_reason, /cannot work as written/);
  });

  test("the waiting peer is released at once, not held for the timeout", async () => {
    const started = Date.now();
    const { payload } = await call(claude, "impl_council_await", { goal_id: goalId, agent: "claude" });
    assert.equal(payload.retry, false);
    assert.match(payload.note, /waiting on the user/);
    assert.ok(Date.now() - started < 1500);
  });

  test("the decision hands the same round back to the author", async () => {
    const { payload } = await call(claude, "impl_council_resume", {
      agent: "claude",
      decision: "app.js is not generated any more. Proceed as the plan says.",
    });
    assert.equal(payload.status, "active");
    assert.equal(payload.phase, "report");
    assert.equal(payload.round, 1, "a decision must not burn a round");
    assert.match(payload.instruction, /The user has answered/);
  });
});

describe("the round cap", () => {
  let root, repo, claude, codex, goalId;

  before(async () => {
    root = makeRoot("impl-cap");
    repo = makeRepo("cap");
    claude = await connect("claude", root);
    codex = await connect("codex", root);
    goalId = (
      await call(claude, "impl_council_open", {
        agent: "claude",
        task: "never quite right",
        project_path: repo,
        max_rounds: 2,
      })
    ).payload.goal_id;
    await call(codex, "impl_council_open", { agent: "codex" });
  });

  after(async () => {
    await claude?.close();
    await codex?.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  // The cap fires on the author's report, so the last review is always answered before the
  // council gives up — the same discipline as the other two modes.
  test("the last review is answered before the cap stops it", async () => {
    let payload;
    for (const round of [1, 2]) {
      ({ payload } = await call(claude, "impl_council_report", {
        goal_id: goalId,
        agent: "claude",
        ...report(),
      }));
      if (round === 1) {
        await call(codex, "impl_council_review", { goal_id: goalId, agent: "codex", ...review() });
      }
    }
    assert.equal(payload.status, "capped");
    assert.match(payload.stop_reason, /2-round cap/);

    const closed = await call(claude, "impl_council_close", { goal_id: goalId, agent: "claude" });
    assert.match(closed.payload.summary, /never approved the work/);
  });
});

// Three modes now, and every one has to block the other two. This is the rule the registry
// exists to keep honest.
describe("one council at a time, across all three modes", () => {
  let root, repo, claude, codex;

  before(async () => {
    root = makeRoot("impl-guard");
    repo = makeRepo("guard");
    claude = await connect("claude", root);
    codex = await connect("codex", root);
  });

  after(async () => {
    await claude?.close();
    await codex?.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  const openImpl = () =>
    call(claude, "impl_council_open", { agent: "claude", task: "some work", project_path: repo });

  test("an implementation council blocks both of the others", async () => {
    const opened = await openImpl();
    assert.equal(opened.payload.status, "active");

    const debate = await call(claude, "council_open", {
      agent: "claude",
      question: "Something else",
      project_path: repo,
    });
    assert.equal(debate.isError, true);
    assert.equal(debate.payload.blocking.mode, "impl_council");
    assert.match(debate.payload.error, /implementation council is unfinished/);

    const plan = await call(claude, "plan_council_open", {
      agent: "claude",
      plan_path: "/proj/other.md",
      project_path: repo,
    });
    assert.equal(plan.isError, true);
    assert.equal(plan.payload.blocking_mode, "impl_council");
  });

  test("council_status points at it rather than claiming there is none", async () => {
    const { payload } = await call(codex, "council_status", { agent: "codex" });
    assert.equal(payload.mode, "impl_council");
    assert.match(payload.note, /Call impl_council_open/);
  });

  test("council_abandon releases it, and then the others open", async () => {
    const { payload } = await call(codex, "council_abandon", {
      agent: "codex",
      reason: "wrong task",
    });
    assert.equal(payload.status, "aborted");
    assert.equal(payload.mode, "impl_council");

    const debate = await call(claude, "council_open", {
      agent: "claude",
      question: "Now unblocked",
      project_path: repo,
    });
    assert.equal(debate.isError ?? false, false);
    await call(claude, "council_abandon", { agent: "claude", reason: "cleanup" });
  });

  test("a debate council blocks the implementation council", async () => {
    const debate = await call(claude, "council_open", {
      agent: "claude",
      question: "In the way",
      project_path: repo,
    });
    await call(claude, "council_submit", {
      goal_id: debate.payload.goal_id,
      agent: "claude",
      ...entry(),
    });

    const blocked = await openImpl();
    assert.equal(blocked.isError, true);
    assert.equal(blocked.payload.blocking_mode, "council");

    await call(claude, "council_abandon", { agent: "claude", reason: "cleanup" });
    const now = await openImpl();
    assert.equal(now.payload.phase, "report");
    await call(claude, "council_abandon", { agent: "claude", reason: "cleanup" });
  });

  test("a plan council blocks it too", async () => {
    await call(claude, "plan_council_open", {
      agent: "claude",
      plan_path: "/proj/in-the-way.md",
      project_path: repo,
    });
    const blocked = await openImpl();
    assert.equal(blocked.isError, true);
    assert.equal(blocked.payload.blocking_mode, "plan_council");
    await call(claude, "council_abandon", { agent: "claude", reason: "cleanup" });
  });
});

// Reviewing work that is already written is the common case, not the exception — the user
// asks for a change, sees it land, and only then wants it checked.
describe("verifying work that already exists", () => {
  let root, repo, claude, codex;

  before(async () => {
    root = makeRoot("impl-existing");
    repo = makeRepo("existing");
    claude = await connect("claude", root);
    codex = await connect("codex", root);
  });

  after(async () => {
    await claude?.close();
    await codex?.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });

  test("uncommitted work is already inside the diff, and the warning says so", async () => {
    writeFileSync(join(repo, "app.js"), "export const one = 1;\nexport const already = 2;\n");

    const { payload } = await call(claude, "impl_council_open", {
      agent: "claude",
      task: "verify what I already wrote",
      project_path: repo,
    });
    assert.equal(payload.dirty_at_open, true);
    assert.ok(payload.diff_lines > 0, "the existing work is what the critic will read");
    assert.match(payload.warning, /they are the work you are having verified/);
    assert.match(payload.warning, /or they are unrelated changes/);

    await call(claude, "council_abandon", { agent: "claude", reason: "cleanup" });
  });

  // The bad case: committed work sits inside HEAD, so a default base makes the diff empty
  // and the critic would verify nothing at all.
  test("committed work with the default base leaves nothing to verify, and says so", async () => {
    git("add", "-A");
    git("commit", "-qm", "the work");

    const opened = await call(claude, "impl_council_open", {
      agent: "claude",
      task: "verify the commit",
      project_path: repo,
    });
    assert.equal(opened.payload.diff_lines, 0);

    const { payload } = await call(claude, "impl_council_report", {
      goal_id: opened.payload.goal_id,
      agent: "claude",
      ...report(),
    });
    assert.match(payload.warning, /diff against .* is empty/);
    assert.match(payload.warning, /base_ref from before the work/);

    await call(claude, "council_abandon", { agent: "claude", reason: "cleanup" });
  });

  test("naming an earlier base brings the committed work back into view", async () => {
    const { payload } = await call(claude, "impl_council_open", {
      agent: "claude",
      task: "verify the commit properly",
      project_path: repo,
      base_ref: "HEAD~1",
    });
    assert.ok(payload.diff_lines > 0, "the commit is now inside the diff");
    assert.match(payload.base_ref, /^[0-9a-f]{40}$/, "the ref is resolved to a commit, not stored raw");
    assert.equal(payload.dirty_at_open, false);

    await call(claude, "council_abandon", { agent: "claude", reason: "cleanup" });
  });

  test("a base git cannot resolve is refused, naming what to pass instead", async () => {
    const { payload, isError } = await call(claude, "impl_council_open", {
      agent: "claude",
      task: "bad base",
      project_path: repo,
      base_ref: "no-such-ref",
    });
    assert.equal(isError, true);
    assert.match(payload.error, /no commit at no-such-ref/);
    assert.match(payload.error, /HEAD~1, a branch name, or a commit sha/);
  });
});

// A council died because the implementation council inherited the plan council's
// thirty-minute step budget. There, a step is "read a plan and write a critique"; here it is
// "write the code", which is the whole point of the mode. The author spent half an hour on
// seven fixes, filed nothing because nothing was finished, and the server killed the council
// thirty minutes and one second after the last review.
describe("the author gets time to actually write the code", () => {
  let root, claude, codex, goalId;

  before(async () => {
    root = makeRoot("impl-step-budget");
    // A step budget far shorter than the wait, so a peer that never files times out inside
    // the test rather than in four hours.
    claude = await connect("claude", root, { COUNCIL_IMPL_STEP_WAIT_MS: "400" });
    codex = await connect("codex", root, { COUNCIL_IMPL_STEP_WAIT_MS: "400" });
  });

  after(async () => {
    await claude?.close();
    await codex?.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("the impl council reports its own step budget, not the plan council's", async () => {
    const opened = await call(claude, "impl_council_open", {
      agent: "claude",
      task: "a long change",
      project_path: process.cwd(),
    });
    goalId = opened.payload.goal_id;
    await call(codex, "impl_council_open", { agent: "codex" });

    // The budget is honoured rather than the plan council's 30 minutes: with it set to
    // 400ms the wait gives up almost at once instead of running for half an hour.
    const started = Date.now();
    let last;
    for (let i = 0; i < 8; i += 1) {
      last = await call(codex, "impl_council_await", { goal_id: goalId, agent: "codex" });
      if (last.payload.retry === false) break;
    }
    assert.equal(last.payload.retry, false, "the wait ended on the configured budget");
    assert.ok(
      Date.now() - started < 30 * 60_000,
      "it did not fall back to the plan council's thirty minutes",
    );
  });
});

// Two gates that stop a council running when it should not have started, or running past the
// point where its rounds still buy anything.
describe("the gates that stop a council going nowhere", () => {
  let root, repo, claude, codex;

  before(async () => {
    root = makeRoot("impl-gates");
    repo = makeRepo("gates");
    claude = await connect("claude", root);
    codex = await connect("codex", root);
  });

  after(async () => {
    await claude?.close();
    await codex?.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  const openOne = async (task) => {
    const opened = await call(claude, "impl_council_open", {
      agent: "claude",
      task,
      project_path: repo,
      plan_path: "/plan.md",
      plan_scope: "all of it",
    });
    await call(codex, "impl_council_open", { agent: "codex" });
    return opened.payload.goal_id;
  };

  // 208 minutes went this way: a council opened to verify work that was not finished, which
  // turns verification into supervised implementation at two full test runs a round.
  test("a first review full of gaps parks rather than starting round 2", async () => {
    const goalId = await openOne("verify the thing is done");
    await call(claude, "impl_council_report", { goal_id: goalId, agent: "claude", ...report() });
    const { payload } = await call(codex, "impl_council_review", {
      goal_id: goalId,
      agent: "codex",
      ...review({ gaps: 4, coverage: "Steps 2, 3, 5 and 6 are not implemented at all." }),
    });

    assert.equal(payload.phase, "user");
    assert.equal(payload.status, "needs_user");
    assert.match(payload.stop_reason, /4 item\(s\) in scope not implemented at all/);
    assert.match(payload.stop_reason, /Finish the work or narrow the scope/);

    // Answering carries it on into round 2 rather than repeating round 1.
    const resumed = await call(claude, "impl_council_resume", {
      goal_id: goalId,
      agent: "claude",
      decision: "Scope was too wide. Narrowed to Step 1 — carry on.",
    });
    assert.equal(resumed.payload.round, 2);
    assert.equal(resumed.payload.phase, "report");
    await call(claude, "council_abandon", { agent: "claude", reason: "cleanup" });
  });

  test("one gap is not enough to park — every council that opened there finished", async () => {
    const goalId = await openOne("verify the other thing");
    await call(claude, "impl_council_report", { goal_id: goalId, agent: "claude", ...report() });
    const { payload } = await call(codex, "impl_council_review", {
      goal_id: goalId,
      agent: "codex",
      ...review({ gaps: 1, coverage: "Step 4's logging is partial." }),
    });
    assert.equal(payload.status, "active");
    assert.equal(payload.round, 2);
    await call(claude, "council_abandon", { agent: "claude", reason: "cleanup" });
  });

  test("three rounds in, the council asks before spending three more", async () => {
    const goalId = await openOne("a change that needs a few rounds");
    for (let round = 1; round <= 3; round += 1) {
      await call(claude, "impl_council_report", { goal_id: goalId, agent: "claude", ...report() });
      const { payload } = await call(codex, "impl_council_review", {
        goal_id: goalId,
        agent: "codex",
        ...review(),
      });
      if (round < 3) {
        assert.equal(payload.status, "active", `round ${round} should carry on`);
        assert.equal(payload.round, round + 1);
      } else {
        assert.equal(payload.status, "needs_user", "round 3 is the review point");
        assert.match(payload.stop_reason, /3 rounds done — the review point/);
        assert.match(payload.stop_reason, /whether another three rounds are worth it/);
      }
    }

    // Carrying on moves the next checkpoint out by three, not to unlimited.
    await call(claude, "impl_council_resume", {
      goal_id: goalId,
      agent: "claude",
      decision: "Worth another three. Carry on.",
    });
    for (let round = 4; round <= 6; round += 1) {
      await call(claude, "impl_council_report", { goal_id: goalId, agent: "claude", ...report() });
      const { payload } = await call(codex, "impl_council_review", {
        goal_id: goalId,
        agent: "codex",
        ...review(),
      });
      if (round < 6) {
        assert.equal(payload.status, "active", `round ${round} should carry on`);
      } else {
        assert.equal(payload.status, "needs_user", "round 6 is the next review point");
      }
    }
    await call(claude, "council_abandon", { agent: "claude", reason: "cleanup" });
  });
});
