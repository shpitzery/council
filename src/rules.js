// Validation and stop rules.
//
// Validation is the part MCP buys us: a submission that breaks a rule here is rejected
// before storage, rather than being requested in prose and drifting over rounds.
//
// The stop rules are honest about their own limits. Rules 2, 3 and 4 read what the models
// report about themselves, and self-reported agreement is exactly the judgment this
// system exists to distrust. Rule 1 — the round cap — is the only one that does not
// depend on a model being sincere, and it is therefore the real guarantee.

import { VERDICTS, CONFIDENCES } from "./db.js";

export const LIMITS = {
  position: 300,
  reasoning: 4,
  evidence: 6,
  text: 2000,
};

export class ValidationError extends Error {
  constructor(field, message) {
    super(`${field}: ${message}`);
    this.field = field;
  }
}

function requireText(value, field, max = LIMITS.text) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(field, "must be a non-empty string");
  }
  if (value.length > max) {
    throw new ValidationError(field, `must be at most ${max} characters, got ${value.length}`);
  }
  return value.trim();
}

function requireList(value, field, maxItems) {
  if (!Array.isArray(value)) throw new ValidationError(field, "must be an array");
  if (value.length === 0) throw new ValidationError(field, "must not be empty");
  if (value.length > maxItems) {
    throw new ValidationError(field, `must have at most ${maxItems} items, got ${value.length}`);
  }
  return value.map((item, i) => requireText(item, `${field}[${i}]`));
}

/**
 * Validate a submission against the council's current state.
 * Throws ValidationError on the first problem, naming the field so the model can fix it.
 */
export function validateSubmission(entry, council, isParticipant) {
  if (!council) throw new ValidationError("goal_id", "no such council");
  if (council.status !== "active") {
    throw new ValidationError("status", `council is ${council.status}, not active`);
  }
  if (!isParticipant) {
    throw new ValidationError("agent", `${entry.agent} has not joined this council`);
  }
  if (entry.round !== council.round) {
    throw new ValidationError(
      "round",
      `council is on round ${council.round}, submission claims ${entry.round}`,
    );
  }

  const clean = {
    agent: entry.agent,
    round: entry.round,
    position: requireText(entry.position, "position", LIMITS.position),
    reasoning: requireList(entry.reasoning, "reasoning", LIMITS.reasoning),
    evidence: requireList(entry.evidence, "evidence", LIMITS.evidence),
    confidence: entry.confidence,
    new_arguments: entry.new_arguments,
    verdict_on_peer: entry.verdict_on_peer ?? null,
    disagreement: entry.disagreement ?? null,
    settling_test: entry.settling_test ?? null,
  };

  if (!CONFIDENCES.includes(clean.confidence)) {
    throw new ValidationError("confidence", `must be one of ${CONFIDENCES.join(", ")}`);
  }
  if (typeof clean.new_arguments !== "boolean") {
    throw new ValidationError("new_arguments", "must be a boolean");
  }

  // Round 1 is answered before either side can see the other, so there is nothing to
  // hold a verdict about. A verdict here would mean the peer was read early.
  if (clean.round === 1) {
    if (clean.verdict_on_peer !== null) {
      throw new ValidationError("verdict_on_peer", "must be omitted on round 1");
    }
  } else {
    if (!VERDICTS.includes(clean.verdict_on_peer)) {
      throw new ValidationError("verdict_on_peer", `must be one of ${VERDICTS.join(", ")}`);
    }
  }

  // A disagreement that does not say what it disagrees with is not admissible.
  if (clean.verdict_on_peer === "DISAGREE") {
    clean.disagreement = requireText(clean.disagreement, "disagreement");
  }
  // An unresolved point is only useful if it names what would settle it.
  if (clean.verdict_on_peer === "UNRESOLVED") {
    clean.settling_test = requireText(clean.settling_test, "settling_test");
  }

  return clean;
}

/**
 * Decide whether the council stops, given the state after a round completed.
 * `latest` is each agent's most recent entry; `all` is every entry.
 * Returns { stop, status, reason } — stop false means carry on to the next round.
 */
export function evaluateStopRules(council, latest, all) {
  // Rule 5 — anything other than active ends it, including the abort kill switch.
  if (council.status !== "active") {
    return { stop: true, status: council.status, reason: `status is ${council.status}` };
  }

  const participants = new Set(all.map((e) => e.agent));
  const completedRound = council.round;
  const thisRound = all.filter((e) => e.round === completedRound);

  // Nothing to judge until both sides have spoken this round.
  if (thisRound.length < participants.size || participants.size < 2) {
    return { stop: false };
  }

  // Rules 2, 3 and 4 are checked before the cap deliberately.
  //
  // The cap's job is to guarantee the council *stops*, not to explain why. A final round
  // that genuinely converges should be reported as converged. Checking the cap first made
  // every such council report "ran out of rounds", which understates the result in the one
  // direction that matters to someone reading the verdict.

  // Rule 2 — both sides say they agree.
  if (thisRound.length > 0 && thisRound.every((e) => e.verdict_on_peer === "AGREE")) {
    return { stop: true, status: "converged", reason: "both agents reported AGREE" };
  }

  // Rule 3 — neither side added anything new. A stalled debate is a finished one.
  if (thisRound.every((e) => e.new_arguments === false)) {
    return {
      stop: true,
      status: "converged",
      reason: "neither agent added a new argument",
    };
  }

  // Rule 4 — the same agent has been stuck on UNRESOLVED for two rounds running.
  // That is a question for the user, not for another round of the same argument.
  for (const agent of participants) {
    const current = all.find((e) => e.agent === agent && e.round === completedRound);
    const previous = all.find((e) => e.agent === agent && e.round === completedRound - 1);
    if (current?.verdict_on_peer === "UNRESOLVED" && previous?.verdict_on_peer === "UNRESOLVED") {
      return {
        stop: true,
        status: "capped",
        reason: `${agent} reported UNRESOLVED in two consecutive rounds`,
      };
    }
  }

  // Rule 1 — the round cap. Last, so it is the reason only when nothing better applies.
  // It remains the only rule that does not depend on a model being sincere, and so it
  // remains the real guarantee that a council terminates.
  if (completedRound >= council.max_rounds) {
    return {
      stop: true,
      status: "capped",
      reason: `reached max_rounds (${council.max_rounds}) with the disagreement still open`,
    };
  }

  return { stop: false };
}

/** The instruction handed to a model for the round it is about to answer. */
export function roundInstruction(council, round) {
  const isFinal = round >= council.max_rounds;

  if (round === 1) {
    return [
      "Answer the question independently. You cannot see the peer's answer yet, and it",
      "cannot see yours — that is deliberate, so neither position anchors the other.",
      "Submit with council_submit, then call council_await_peer to read their answer.",
    ].join(" ");
  }

  if (isFinal) {
    return [
      `This is the final round (${round} of ${council.max_rounds}).`,
      "Do not introduce new arguments. State your final position, and name explicitly what",
      "remains unresolved. If you still disagree, quote the exact line you contest.",
    ].join(" ");
  }

  return [
    `Round ${round} of at most ${council.max_rounds}.`,
    "Read the peer's last answer. Say where you agree and where you disagree, and why.",
    "Every DISAGREE must quote the exact line it contests. If you cannot cite evidence,",
    "mark it UNRESOLVED and name the check that would settle it.",
  ].join(" ");
}
