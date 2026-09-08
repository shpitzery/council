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

// How many rounds run before the council stops and asks whether to carry on.
//
// Not a cap — a checkpoint the user owns. The cap is a wall the loop hits after spending
// everything; this is a place it stops while there is still budget to spend, says what still
// stands, and lets the user decide whether another round is worth it.
//
// Three, from three independent directions. GitHub's HydraFusion reaches within 0.1
// percentage points of Opus 5 on CheckpointBench with *one* draft-critique-revise cycle at
// 65% lower cost, and its Rubber Duck critic fires at chosen moments rather than on a
// cadence. The findings here are front-loaded the same way: one real council went 3 High and
// 4 gaps at round 1 to 1 High and 1 gap by round 3. And the rounds past that are where the
// loop turns on itself — a nine-round council recorded rounds 6, 7 and 8 as entirely defects
// its own earlier repairs had introduced.
//
// The cap was raised 4 to 5 to 10 because rounds kept being needed. That treated the
// symptom: a high cap is not a safety margin, it is permission to keep going.
export const REVIEW_EVERY = 3;

/**
 * The round this council next stops at to ask.
 *
 * Derived from the steps rather than stored, like every other piece of phase in this file.
 * Each time the user says carry on, the next checkpoint moves another REVIEW_EVERY rounds
 * out, so the answer is "three more rounds", never "unlimited from here".
 *
 * A checkpoint resume is told apart from a content decision by what it followed: a decision
 * after a step that raised no question of its own is the user answering "carry on", and a
 * decision after one that did is the user settling what was asked.
 */
export function reviewPointAt(steps) {
  let resumed = 0;
  for (let i = 0; i < steps.length; i += 1) {
    if (steps[i].kind !== "decision") continue;
    const prior = lastNonDecision(steps, i);
    if (prior && !raisedAQuestion(prior)) resumed += 1;
  }
  return REVIEW_EVERY * (resumed + 1);
}

/** The nearest step before `index` that is not itself a decision. */
export function lastNonDecision(steps, index) {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (steps[i].kind !== "decision") return steps[i];
  }
  return null;
}

/** Did this step raise something the user had to answer? */
function raisedAQuestion(step) {
  if (step.kind === "resolve") return Boolean(step.needs_user);
  if (step.kind === "critique") return (step.decisions ?? 0) > 0;
  return false;
}

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
  // An unmade decision is not a defect the author can fix, so no amount of rounds retires
  // it. Readiness cannot be reported over one, whichever way the critic worded the line.
  if ((step.decisions ?? 0) > 0) return { ready: false };
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
    // How many of those blocking findings are unmade decisions rather than defects.
    decisions: requireCount(fields.decisions ?? 0, "decisions"),
    decision_list: optionalText(fields.decision_list, "decision_list", LIMITS_PLAN.block),
    critic_readiness: fields.readiness,
  };

  // A decision is a subset of the blocking findings, never an extra pile beside them. The
  // count exists so the server can route them; it cannot route what it cannot see inside
  // the blocking set.
  if (clean.decisions > clean.blockers + clean.highs) {
    throw new ValidationError(
      "decisions",
      `${clean.decisions} decisions cannot exceed the ${clean.blockers + clean.highs} ` +
        "Blocker and High findings they are drawn from. Only Blocker and High findings " +
        "are counted here; a Medium decision belongs in the critique text alone.",
    );
  }

  // The whole point is to hand the user something answerable. A count with no questions
  // parks the council on nothing.
  if (clean.decisions > 0 && !clean.decision_list) {
    throw new ValidationError(
      "decision_list",
      `${clean.decisions} decision(s) reported with none written down. List each one as a ` +
        "question with the defensible options, because the council is about to park and " +
        "hand exactly this text to the user.",
    );
  }
  if (clean.decisions === 0 && clean.decision_list) {
    throw new ValidationError(
      "decisions",
      "decision_list was given but decisions is 0. Count them, or leave the list empty.",
    );
  }

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

export function validateResolve(fields, round, critique = null) {
  const clean = {
    kind: "resolve",
    actor: AUTHOR,
    round,
    applied: requireText(fields.applied, "applied", LIMITS_PLAN.block),
    rejected: optionalText(fields.rejected, "rejected", LIMITS_PLAN.block),
    additional: optionalText(fields.additional, "additional", LIMITS_PLAN.block),
    deferred: optionalText(fields.deferred, "deferred", LIMITS_PLAN.block),
    needs_user: optionalText(fields.needs_user_decision, "needs_user_decision", LIMITS_PLAN.block),
    author_readiness: fields.readiness,
  };

  if (!AUTHOR_READINESS.includes(clean.author_readiness)) {
    throw new ValidationError("readiness", `must be one of ${AUTHOR_READINESS.join(", ")}`);
  }

  // Once the gate is open, a Medium no longer holds the plan back — so a Medium applied
  // here buys nothing and costs length. Five real rounds ended with 19 findings applied and
  // none rejected, and the plan grew 154 lines to 332 while every warning about its size
  // sat unread in the reply.
  //
  // The server cannot see which findings the author touched; the critique is one block of
  // text and the severities are only counts. What it can do is refuse to let the
  // non-blocking ones pass unmentioned, so folding a Medium in becomes a decision someone
  // wrote down rather than the path of least resistance.
  //
  // This only ever fires on a mixed critique. A round at or past the gate with no Blocker
  // and no High is already `ready` in planState, and never reaches a resolve at all.
  const nonBlocking = (critique?.mediums ?? 0) + (critique?.lows ?? 0);
  if (round >= SEVERITY_GATE_ROUND && nonBlocking > 0 && !clean.deferred) {
    throw new ValidationError(
      "deferred",
      `round ${round} carried ${nonBlocking} Medium/Low finding(s), and from round ` +
        `${SEVERITY_GATE_ROUND} those no longer hold the plan back. Say what you did with ` +
        "them: defer them by name, or name the ones you applied anyway and why they were " +
        "worth the length. Blockers and Highs are unaffected — fix those.",
    );
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
    // Checked before readiness and before handing the round to the author. A decision is
    // the user's to make, and the author resolving around it is how six rounds get spent
    // designing a plan one guess at a time.
    if ((last.decisions ?? 0) > 0) {
      return {
        phase: "user",
        actor: null,
        round: last.round,
        status: "needs_user",
        reason:
          `the critic found ${last.decisions} decision(s) that are the user's to make, ` +
          "not defects the author can fix",
      };
    }
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
    // The checkpoint. Rounds past this one are the ones that historically turn on
    // themselves, so the council stops here with budget left and asks rather than spending
    // it. Answering carries it another REVIEW_EVERY rounds; the cap above is still the wall.
    const reviewAt = reviewPointAt(steps);
    if (last.round >= reviewAt) {
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
    return { phase: "critique", actor: CRITIC, round: last.round + 1 };
  }

  // Where a decision hands the council depends on what it answered.
  //
  // A question raised by a step — the author's needs_user_decision, or the critic's
  // decisions — comes back to the author to apply, in the same round. No new critique was
  // consumed, and burning a round on a hand-back would spend part of the budget on it.
  //
  // A checkpoint answer is different: the round it paused was already finished, so carrying
  // on means the next round's critique.
  const prior = lastNonDecision(steps, steps.length - 1);
  if (prior?.kind === "resolve" && !prior.needs_user) {
    return { phase: "critique", actor: CRITIC, round: last.round + 1 };
  }
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
  "",
  "Split your Blocker and High findings two ways, and put the second number in `decisions`.",
  "A *defect* is where the plan contradicts itself, the code, or the task contract, or cannot",
  "be executed as written — one right answer exists and the author can apply it. A *decision*",
  "is where the plan does not say and two or more answers are defensible. The test is whether",
  "you can name the options: if you cannot state two you would defend, it is a defect with one",
  "right answer, not a decision.",
  "",
  "Anything above zero in `decisions` parks the council and hands `decision_list` to the user",
  "verbatim, so write each one as a question with its options. This is not a way to hand back",
  "work you would rather not think about — it is for the questions no edit to the plan can",
  "settle. A council once spent six rounds and an hour watching the author guess at four of",
  "them, and each guess produced the next round's findings.",
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
  "decision recorded in a sentence. This loop only ever adds, over up to ten rounds, and a",
  "plan that grows a section per finding stops being something anyone can implement from.",
  "Watch plan_lines: if a round adds more than it changes, you are writing a specification.",
  "",
  `From round ${SEVERITY_GATE_ROUND} a Medium or Low no longer holds the plan back, so`,
  "applying one buys nothing and costs length. Default to deferring them: fix the Blockers",
  "and Highs, and list the rest in `deferred` by name. Applying one anyway is allowed — say",
  "in `deferred` which, and why it was worth the lines.",
].join(" ");

export const DECIDED_INSTRUCTION = [
  "The user has answered the decision you raised. Apply it to the plan with your",
  "`plan-critique-resolver` skill, then resolve again for this same round — the round does",
  "not advance, because no new critique was raised.",
].join(" ");
