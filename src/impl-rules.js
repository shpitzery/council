// The implementation council's state machine and validation.
//
// The first mode that runs *after* code is written. The question is not "is this code good"
// but "is what was asked actually done, and does it work" — two checks that come apart. A
// change can be correct and half-finished, or complete and broken.
//
// Its stop signal is the strongest in this project. The plan council stops when a critic
// declares a plan ready, which is a judgement about text. Here the critic can run the thing:
// approval carries evidence, not an opinion.

import { ValidationError } from "./rules.js";
import { REVIEW_EVERY, reviewPointAt, lastNonDecision } from "./plan-rules.js";

// Fixed, as in the plan council. Claude writes the code because Claude was asked to; Codex
// verifies because a verdict from the side that did the work is worth nothing.
export const AUTHOR = "claude";
export const CRITIC = "codex";

export const VERDICTS_IMPL = ["Approve", "Changes needed"];
export const MATCHES = ["yes", "no"];

export const LIMITS_IMPL = {
  block: 20_000,
  short: 8_000,
};

// From this round on, only Blocker and High hold the work back. A thorough reviewer finds
// new Medium issues forever, because every fix creates new surface.
export const SEVERITY_GATE_ROUND = 3;

function requireText(value, field, max) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(field, "must be a non-empty string");
  }
  if (value.length > max) {
    throw new ValidationError(field, `must be at most ${max} characters, got ${value.length}`);
  }
  return value.trim();
}

function optionalText(value, field, max) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ValidationError(field, "must be a string");
  const trimmed = value.trim();
  // "None." is how these reports say empty. Treating it as content would park every council
  // on the first report.
  if (trimmed === "" || /^none\.?$/i.test(trimmed)) return null;
  if (trimmed.length > max) {
    throw new ValidationError(field, `must be at most ${max} characters, got ${trimmed.length}`);
  }
  return trimmed;
}

function requireCount(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw new ValidationError(field, "must be a whole number, zero or more");
  }
  return value;
}

export function validateReport(fields, round) {
  return {
    kind: "report",
    actor: AUTHOR,
    round,
    summary: requireText(fields.summary, "summary", LIMITS_IMPL.block),
    applied: optionalText(fields.applied, "applied", LIMITS_IMPL.block),
    rejected: optionalText(fields.rejected, "rejected", LIMITS_IMPL.block),
    needs_user: optionalText(fields.needs_user_decision, "needs_user_decision", LIMITS_IMPL.block),
  };
}

/**
 * Validate a review, and refuse the approvals that would hollow out the stop signal.
 *
 * `hasPlan` decides whether gaps are meaningful at all: without a plan there is nothing for
 * the work to be incomplete against.
 */
export function validateReview(fields, round, hasPlan) {
  const clean = {
    kind: "review",
    actor: CRITIC,
    round,
    findings: requireText(fields.findings, "findings", LIMITS_IMPL.block),
    blockers: requireCount(fields.blockers, "blockers"),
    highs: requireCount(fields.highs, "highs"),
    mediums: requireCount(fields.mediums, "mediums"),
    lows: requireCount(fields.lows, "lows"),
    gaps: requireCount(fields.gaps ?? 0, "gaps"),
    coverage: optionalText(fields.coverage, "coverage", LIMITS_IMPL.block),
    verdict: fields.verdict,
    verification: requireText(fields.verification, "verification", LIMITS_IMPL.block),
    report_matches_diff: fields.report_matches_diff,
    mismatch: optionalText(fields.mismatch, "mismatch", LIMITS_IMPL.short),
    plan_defect: optionalText(fields.plan_defect, "plan_defect", LIMITS_IMPL.short),
  };

  if (!VERDICTS_IMPL.includes(clean.verdict)) {
    throw new ValidationError("verdict", `must be one of ${VERDICTS_IMPL.join(", ")}`);
  }
  if (!MATCHES.includes(clean.report_matches_diff)) {
    throw new ValidationError("report_matches_diff", `must be one of ${MATCHES.join(", ")}`);
  }

  // A mismatch that does not say what is missing or unmentioned is not admissible, the same
  // way a DISAGREE without its quoted line is not.
  if (clean.report_matches_diff === "no" && !clean.mismatch) {
    throw new ValidationError(
      "mismatch",
      "required when report_matches_diff is no. Say what the report claims and the diff does " +
        "not do, or what the diff changes and the report never mentions.",
    );
  }

  if (!hasPlan && clean.gaps > 0) {
    throw new ValidationError(
      "gaps",
      "no plan is attached to this council, so there is nothing for the work to be " +
        "incomplete against. Report the concern as a finding instead.",
    );
  }
  if (hasPlan && clean.gaps > 0 && !clean.coverage) {
    throw new ValidationError(
      "coverage",
      `required when gaps is ${clean.gaps}. Name which items in scope are missing or partial.`,
    );
  }

  if (clean.verdict === "Approve") {
    // Each of these is a way an approval could mean less than it appears to.
    if (clean.blockers + clean.highs > 0) {
      throw new ValidationError(
        "verdict",
        `cannot Approve with ${clean.blockers} Blocker and ${clean.highs} High findings. ` +
          "Either downgrade them in the findings or report Changes needed.",
      );
    }
    if (clean.gaps > 0) {
      throw new ValidationError(
        "verdict",
        `cannot Approve with ${clean.gaps} item(s) in scope still unimplemented. Complete is ` +
          "the point of this mode; incomplete is never approved, at any round.",
      );
    }
    if (clean.report_matches_diff === "no") {
      throw new ValidationError(
        "verdict",
        "cannot Approve while the report does not match the diff. A change nobody mentioned, " +
          "or a claim the diff does not support, has to be settled first.",
      );
    }
  }

  return clean;
}

export function validateDecision(decision) {
  return requireText(decision, "decision", LIMITS_IMPL.short);
}

/** Does this review let the work through? */
export function reviewApproves(step) {
  if (step.verdict !== "Approve") return { ready: false };
  return { ready: true, reason: "the critic approved the implementation" };
}

// Gaps in the first review that mean the work was not finished when the council opened.
//
// This mode verifies work that is done. Opened on work that is not, it becomes a supervised
// implementation session where every round costs the author a full test run and the critic
// another one — one real council spent 208 minutes that way, and 4 of its round-1 findings
// were gaps.
//
// Three, from the record. Of eighteen implementation councils, every one that opened with no
// gaps or one reached `ready`; of the seven that opened with three or more, only three did —
// the rest were aborted, capped, or errored. The line falls cleanly between one and three.
export const UNFINISHED_GAPS = 3;

/**
 * Whose move it is, given every step so far.
 * Returns { phase, actor, round, status, reason } where phase is
 * "report" | "review" | "user" | "final".
 */
export function implState(steps, maxRounds) {
  const last = steps.length ? steps[steps.length - 1] : null;

  // Nothing to verify until the author has written something.
  if (!last) return { phase: "report", actor: AUTHOR, round: 1 };

  if (last.kind === "report") {
    if (last.needs_user) {
      return {
        phase: "user",
        actor: null,
        round: last.round,
        status: "needs_user",
        reason: "the author reached a decision that is the user's to make",
      };
    }
    if (last.round >= maxRounds) {
      return {
        phase: "final",
        round: last.round,
        status: "capped",
        reason:
          `reached the ${maxRounds}-round cap without the critic approving. The last review ` +
          "says what it still objects to; the code holds every fix applied so far.",
      };
    }
    return { phase: "review", actor: CRITIC, round: last.round };
  }

  if (last.kind === "review") {
    // Checked before approval: a plan that cannot work as written is the user's call, and an
    // approval built on a broken plan step is worth nothing.
    if (last.plan_defect) {
      return {
        phase: "user",
        actor: null,
        round: last.round,
        status: "needs_user",
        reason: "the critic believes a step in the plan itself cannot work as written",
      };
    }
    const verdict = reviewApproves(last);
    if (verdict.ready) {
      return {
        phase: "final",
        round: last.round,
        status: "ready",
        reason: `the implementation is complete and verified — ${verdict.reason}`,
      };
    }
    // Round 1 only. Later rounds close gaps as they go, and stopping on those would park a
    // council that is doing exactly what it should.
    if (last.round === 1 && (last.gaps ?? 0) >= UNFINISHED_GAPS) {
      return {
        phase: "user",
        actor: null,
        round: last.round,
        status: "needs_user",
        reason:
          `the first review found ${last.gaps} item(s) in scope not implemented at all. ` +
          "This mode verifies finished work; on unfinished work it turns into a supervised " +
          "implementation session, at two full verification passes a round. Finish the work " +
          "or narrow the scope, then carry on.",
      };
    }
    const reviewAt = reviewPointAt(steps);
    if (last.round >= reviewAt && last.round < maxRounds) {
      return {
        phase: "user",
        actor: null,
        round: last.round,
        status: "needs_user",
        reason:
          `${last.round} rounds done — the review point. Nothing is wrong; this is where ` +
          "the council asks whether another three rounds are worth it, rather than spending " +
          "them and telling you afterwards.",
      };
    }
    return { phase: "report", actor: AUTHOR, round: last.round + 1 };
  }

  // Where a decision hands the council depends on what it answered. A question raised by a
  // step comes back to the author in the same round — no new review was consumed. A review
  // that raised none was a checkpoint or a gap gate, and carrying on means the next round.
  const prior = lastNonDecision(steps, steps.length - 1);
  if (prior?.kind === "review" && !prior.plan_defect) {
    return { phase: "report", actor: AUTHOR, round: last.round + 1 };
  }
  return { phase: "report", actor: AUTHOR, round: last.round };
}

export const REPORT_INSTRUCTION = [
  "Do the work, then report it. Say what you changed and why, file by file where it matters.",
  "The critic will read the real diff, so a report that does not match it is itself a finding —",
  "mention everything you touched, including anything you changed in passing.",
  "",
  "If a review came back, run your `superpowers:receiving-code-review` skill against it before",
  "you touch anything: verify each point against the code, apply what holds, and push back on",
  "what does not with a reason. Never guess at something that is the user's decision — put it",
  "in `needs_user_decision` and the council hands it back to them.",
].join(" ");

export const REVIEW_INSTRUCTION = [
  "Run your `verify-implementation` skill against the recorded base_ref. Two passes, in order:",
  "is the work complete against the plan and scope, then is it correct.",
  "",
  "Approval has to carry evidence. Running the tests is one way; reading the call sites and",
  "showing why nothing breaks is another. What is not acceptable is approving because it looks",
  "right. The server refuses an Approve with Blockers, with unimplemented scope, or with a",
  "report that does not match the diff.",
  "",
  "Never edit the code. The author owns the tree; two writers on it means the report stops",
  "describing reality. If a step in the plan itself cannot work, say so in `plan_defect` — the",
  "plan already survived its own council and is not yours to reopen.",
].join(" ");

export const DECIDED_INSTRUCTION = [
  "The user has answered. Apply their decision, then report again for this same round — the",
  "round does not advance, because no new review was raised.",
].join(" ");
