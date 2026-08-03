// The plan council's state machine and validation.
//
// This mode automates a loop the user runs by hand: Codex critiques an implementation plan
// with its `critique-plan` skill, Claude answers with `plan-critique-resolver`, which edits
// the plan file directly, and round after round until the critic says the plan is ready.
//
// The stop rule is the strongest in this project. The debate mode stops when both sides
// report agreeing, which is self-reported and therefore the weakest signal here. This mode
// stops when the *critic* declares the plan ready — a verdict from the side whose job is to
// find fault.

import { ValidationError } from "./rules.js";

// Fixed. The user's workflow is always Claude-authors / Codex-critiques, and the swap was
// dropped because Codex has no plan-critique-resolver skill to author with.
export const AUTHOR = "claude";
export const CRITIC = "codex";

export const CRITIC_READINESS = ["Ready", "Not ready"];
export const AUTHOR_READINESS = ["READY", "NOT READY"];

// Free-text blocks — the debate mode's one-sentence position and capped bullet lists are
// the wrong shape for a critique with four Blockers. These caps exist only so a runaway
// model cannot write an unbounded blob into SQLite.
export const LIMITS_PLAN = {
  critique: 20_000,
  block: 12_000,
  decision: 8_000,
};

// From this round on, only Blocker and High hold the plan back. A thorough critic finds new
// Medium issues forever, because every revision creates new surface — without this the loop
// never ends on its own and the round cap becomes the only exit.
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
  // The resolver writes "None." when a block is empty. Treat that as empty rather than as
  // an unresolved decision, or every council would park on the first resolve.
  const trimmed = value.trim();
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

/** Is this critique a green light, given which round it landed in? */
export function criticSaysReady(step) {
  if (step.critic_readiness === "Ready") return { ready: true, reason: "the critic reported Ready" };
  if (
    step.round >= SEVERITY_GATE_ROUND &&
    (step.blockers ?? 0) === 0 &&
    (step.highs ?? 0) === 0
  ) {
    const left = (step.mediums ?? 0) + (step.lows ?? 0);
    return {
      ready: true,
      reason:
        `no Blocker or High findings remained at round ${step.round}` +
        (left ? `; ${left} Medium/Low finding${left === 1 ? "" : "s"} left standing` : ""),
    };
  }
  return { ready: false };
}

export function validateCritique(fields, council, round) {
  const clean = {
    kind: "critique",
    actor: CRITIC,
    round,
    critique: requireText(fields.critique, "critique", LIMITS_PLAN.critique),
    blockers: requireCount(fields.blockers, "blockers"),
    highs: requireCount(fields.highs, "highs"),
    mediums: requireCount(fields.mediums, "mediums"),
    lows: requireCount(fields.lows, "lows"),
    critic_readiness: fields.readiness,
  };

  if (!CRITIC_READINESS.includes(clean.critic_readiness)) {
    throw new ValidationError("readiness", `must be one of ${CRITIC_READINESS.join(", ")}`);
  }
  // A critic cannot wave through its own blocking findings. This is the one rule that
  // protects the stop signal, and the stop signal is the whole reason this mode is better
  // than the debate mode.
  if (clean.critic_readiness === "Ready" && clean.blockers + clean.highs > 0) {
    throw new ValidationError(
      "readiness",
      `cannot be Ready with ${clean.blockers} Blocker and ${clean.highs} High findings. ` +
        "Either downgrade them in the critique or report Not ready.",
    );
  }
  return clean;
}

export function validateResolve(fields, round) {
  const clean = {
    kind: "resolve",
    actor: AUTHOR,
    round,
    applied: requireText(fields.applied, "applied", LIMITS_PLAN.block),
    rejected: optionalText(fields.rejected, "rejected", LIMITS_PLAN.block),
    additional: optionalText(fields.additional, "additional", LIMITS_PLAN.block),
    needs_user: optionalText(fields.needs_user_decision, "needs_user_decision", LIMITS_PLAN.block),
    author_readiness: fields.readiness,
  };

  if (!AUTHOR_READINESS.includes(clean.author_readiness)) {
    throw new ValidationError("readiness", `must be one of ${AUTHOR_READINESS.join(", ")}`);
  }
  // The resolver's own rule: READY requires no unresolved decision. Honouring it here is
  // what makes the hand-back to the user fall out rather than being bolted on.
  if (clean.author_readiness === "READY" && clean.needs_user) {
    throw new ValidationError(
      "readiness",
      "cannot be READY while a decision is still the user's to make. Report NOT READY — " +
        "the council parks and hands the decision back.",
    );
  }
  return clean;
}

export function validateDecision(decision) {
  return requireText(decision, "decision", LIMITS_PLAN.decision);
}

/**
 * Whose move it is, given every step so far.
 * Returns { phase, actor, round, reason } where phase is
 * "critique" | "resolve" | "user" | "final".
 *
 * The status a finished council should carry is `status`, present only when phase is
 * "final" or "user".
 */
export function planState(steps, maxRounds) {
  const last = steps.length ? steps[steps.length - 1] : null;

  if (!last) return { phase: "critique", actor: CRITIC, round: 1 };

  if (last.kind === "critique") {
    const verdict = criticSaysReady(last);
    if (verdict.ready) {
      return {
        phase: "final",
        round: last.round,
        status: "ready",
        reason: `the plan is implementation-ready — ${verdict.reason}`,
      };
    }
    return { phase: "resolve", actor: AUTHOR, round: last.round };
  }

  if (last.kind === "resolve") {
    // Checked before the cap: a decision the user owes is not a council that ran out of
    // rounds, and reporting it as capped would bury the question they need to answer.
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
          `reached the ${maxRounds}-round cap without the critic reporting Ready. ` +
          "The plan holds every fix applied so far; the last critique was answered.",
      };
    }
    return { phase: "critique", actor: CRITIC, round: last.round + 1 };
  }

  // A decision hands the same round back to the author, who applies it and resolves again.
  // The round does not advance: no new critique was consumed, and burning a round on the
  // user's answer would spend a quarter of the budget on a hand-back.
  return { phase: "resolve", actor: AUTHOR, round: last.round };
}

export const CRITIQUE_INSTRUCTION = [
  "Run your `critique-plan` skill against the plan file, then submit its output here",
  "unchanged. `Needs Fix` items go in `critique`, the tally of each severity goes in the",
  "four count fields, and `Readiness` goes in `readiness`.",
  "",
  "Do not soften a finding to move the loop along. From round 3 only Blocker and High hold",
  "the plan back, so a real Medium belongs in the critique and will not stall anything.",
  "",
  "Name the decision each fix needs; do not draft the text that settles it. `Fix: freeze the",
  "exception ordering` is a finding. Three paragraphs of ordering is a specification, and the",
  "author will paste it into the plan — that is how a plan turns into a document nobody can",
  "implement from.",
].join(" ");

export const RESOLVE_INSTRUCTION = [
  "Run your `plan-critique-resolver` skill with the critique above and the plan file, then",
  "submit its output blocks here. The skill edits the plan file itself — this call records",
  "what it did, it does not apply anything.",
  "",
  "Rejecting a critique needs the reason the skill already produces. Never guess at",
  "something in `Needs User Decision` to keep the loop moving: put it in",
  "`needs_user_decision` and the council hands it back to the user.",
  "",
  "Integrate each finding as the smallest change that settles it — an edited line, or the",
  "decision recorded in a sentence. This loop only ever adds, over up to four rounds, and a",
  "plan that grows a section per finding stops being something anyone can implement from.",
  "Watch plan_lines: if a round adds more than it changes, you are writing a specification.",
].join(" ");

export const DECIDED_INSTRUCTION = [
  "The user has answered the decision you raised. Apply it to the plan with your",
  "`plan-critique-resolver` skill, then resolve again for this same round — the round does",
  "not advance, because no new critique was raised.",
].join(" ");
