// The cross-mode registry.
//
// Some rules are not about any one mode: one council at a time, the kill switch, what
// council_status reports, and clearing what a dead session left behind. Each of those used
// to name every mode by hand, so a new mode meant editing every one of them — and every
// mode had to be taught about every other. Two modes made that four branches. Three would
// have made it nine.
//
// Adding a mode is now one entry in MODES. The rules loop.
//
// Nothing here imports a mode's tool module, and no tool module imports this, so the
// registry stays free of cycles.

import {
  getCouncil,
  getActiveCouncilForAgent,
  getConcludedCouncilsForAgent,
  getAllEntries,
  getDrafter,
  getDrafts,
  setStatus,
  getPlanCouncil,
  getUnfinishedPlanCouncil,
  getPlanSteps,
  getPlanParticipants,
  setPlanStatus,
  getImplCouncil,
  getUnfinishedImplCouncil,
  getImplSteps,
  getImplParticipants,
  setImplStatus,
} from "./db.js";
import { draftState } from "./rules.js";
import { planState } from "./plan-rules.js";
import { implState } from "./impl-rules.js";

const AGENTS = ["claude", "codex"];
const peerOf = (agent) => AGENTS.find((a) => a !== agent);

// Only a council that reached a conclusion gets an answer drafted. An aborted one was killed
// on purpose and an errored one lost a participant.
const DRAFTABLE = ["converged", "capped"];

const ms = (iso) => new Date(iso).getTime();

/**
 * The debate council an agent still owes work on.
 *
 * "Unfinished" is not "active": a council whose rounds ended still owes an answer, and
 * treating it as done once let an agent walk away mid-draft and strand its peer.
 */
function unfinishedDebate(db, agent) {
  const active = getActiveCouncilForAgent(db, agent);
  if (active) return active;

  for (const council of getConcludedCouncilsForAgent(db, agent, DRAFTABLE)) {
    const drafter = getDrafter(db, council.goal_id);
    const state = draftState(getDrafts(db, council.goal_id), drafter, peerOf(drafter));
    if (state.phase !== "final") return council;
  }
  return null;
}

/** The most recent moment anyone touched a council of any mode, from its own step records. */
const latest = (times) => Math.max(...times.filter(Number.isFinite));

export const MODES = [
  {
    name: "council",
    label: "council",
    reopen: "council_open",
    findUnfinished: (db, agent) => unfinishedDebate(db, agent),
    get: (db, goalId) => getCouncil(db, goalId),
    abort: (db, goalId, reason) => setStatus(db, goalId, "aborted", reason),
    brief: (db, council) => ({
      goal_id: council.goal_id,
      mode: "council",
      question: council.question,
      status: council.status,
      round: council.round,
    }),
    lastTouch: (db, council) =>
      latest([
        ms(council.updated_at),
        ...getAllEntries(db, council.goal_id).map((e) => ms(e.submitted_at)),
        ...getDrafts(db, council.goal_id).flatMap((d) => [
          ms(d.drafted_at),
          d.reviewed_at ? ms(d.reviewed_at) : NaN,
        ]),
      ]),
  },

  {
    name: "plan_council",
    label: "plan council",
    reopen: "plan_council_open",
    // Both agents are in every plan council by construction — the roles are fixed — so the
    // guard is one question either side can ask, with no agent to scope it to.
    findUnfinished: (db) => getUnfinishedPlanCouncil(db),
    get: (db, goalId) => getPlanCouncil(db, goalId),
    abort: (db, goalId, reason) => setPlanStatus(db, goalId, "aborted", reason),
    brief: (db, council) => {
      const state = planState(getPlanSteps(db, council.goal_id), council.max_rounds);
      return {
        goal_id: council.goal_id,
        mode: "plan_council",
        plan_path: council.plan_path,
        status: council.status,
        phase: state.phase,
        next_actor: state.actor ?? null,
        round: state.round,
      };
    },
    lastTouch: (db, council) => {
      const steps = getPlanSteps(db, council.goal_id);
      return latest([
        ms(council.started_at),
        ...getPlanParticipants(db, council.goal_id).map((p) => ms(p.joined_at)),
        ...(steps.length ? [ms(steps.at(-1).created_at)] : []),
      ]);
    },
  },

  {
    name: "impl_council",
    label: "implementation council",
    reopen: "impl_council_open",
    findUnfinished: (db) => getUnfinishedImplCouncil(db),
    get: (db, goalId) => getImplCouncil(db, goalId),
    abort: (db, goalId, reason) => setImplStatus(db, goalId, "aborted", reason),
    brief: (db, council) => {
      const state = implState(getImplSteps(db, council.goal_id), council.max_rounds);
      return {
        goal_id: council.goal_id,
        mode: "impl_council",
        task: council.task,
        plan_path: council.plan_path ?? null,
        status: council.status,
        phase: state.phase,
        next_actor: state.actor ?? null,
        round: state.round,
      };
    },
    lastTouch: (db, council) => {
      const steps = getImplSteps(db, council.goal_id);
      return latest([
        ms(council.started_at),
        ...getImplParticipants(db, council.goal_id).map((p) => ms(p.joined_at)),
        ...(steps.length ? [ms(steps.at(-1).created_at)] : []),
      ]);
    },
  },
];

const modeByName = (name) => MODES.find((m) => m.name === name) ?? null;

/**
 * Unfinished work in every mode except the one asking, as {mode, council, brief}.
 *
 * This is the one-at-a-time guard. A council mid-flight in any mode means a peer is waiting
 * on this agent somewhere; starting another would strand it.
 */
export function unfinishedElsewhere(db, agent, exclude) {
  const found = [];
  for (const mode of MODES) {
    if (mode.name === exclude) continue;
    const council = mode.findUnfinished(db, agent);
    if (council) found.push({ mode, council, brief: mode.brief(db, council) });
  }
  return found;
}

/** A council with this id, whichever mode owns it. */
export function findAnyCouncil(db, goalId) {
  for (const mode of MODES) {
    const council = mode.get(db, goalId);
    if (council) return { mode, council };
  }
  return null;
}

/**
 * Clear unfinished work that has sat untouched past `idleMs`, and report what was cleared.
 *
 * A council left behind by a dead session is the normal case, not the exception — one user
 * drives every window by hand, and runs kept being derailed by leftovers. The idle threshold
 * is the safeguard: anything recent may be a peer mid-turn, so it still blocks.
 *
 * `protect` is how a mode says "this one is a resume, not a leftover" — the plan council uses
 * it to never sweep a council on the plan being opened, however old.
 */
export function sweepStale(db, idleMs, { agent, exclude, protect = () => false } = {}) {
  const cleared = [];

  for (const mode of MODES) {
    if (mode.name === exclude) continue;

    for (let guard = 0; guard < 10; guard += 1) {
      const council = mode.findUnfinished(db, agent);
      if (!council || protect(mode, council)) break;

      const idle = Date.now() - mode.lastTouch(db, council);
      if (idle <= idleMs) break;

      const minutes = Math.round(idle / 60_000);
      // Captured before the abort, so the report says what the council was about and what
      // state it was in — "cleared 2026-08-03-plan-foo" alone tells the user nothing.
      const brief = mode.brief(db, council);
      mode.abort(
        db,
        council.goal_id,
        `cleared automatically: unfinished and untouched for ${minutes} minutes when new ` +
          "work was started",
      );
      cleared.push({
        ...brief,
        goal_id: council.goal_id,
        mode: mode.name,
        was: brief.status,
        idle_minutes: minutes,
      });
    }
  }
  return cleared;
}

export { modeByName };
