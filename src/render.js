// Disk rendering. SQLite is the truth; these files exist so a human can read the record
// without the server running. Nothing here is ever read back as state.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const ROOT = process.env.COUNCIL_ROOT || join(homedir(), ".council");

export const councilDir = (goalId) => join(ROOT, goalId);
export const databasePath = () => join(ROOT, "council.db");

export function ensureCouncilDir(goalId) {
  const dir = councilDir(goalId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeBrief(council) {
  const dir = ensureCouncilDir(council.goal_id);
  const lines = [
    `# Council — ${council.goal_id}`,
    "",
    "## Question",
    "",
    council.question,
    "",
    "## Context",
    "",
    `- Project: ${council.project_path}`,
    council.git_branch ? `- Branch: ${council.git_branch}` : null,
    `- Started: ${council.started_at}`,
    `- Maximum rounds: ${council.max_rounds}`,
    "",
    "## How this ends",
    "",
    "The council stops when both sides agree, when neither adds a new argument, when one",
    `side is stuck on UNRESOLVED twice running, or after ${council.max_rounds} rounds.`,
    "",
    "Only the round cap does not depend on the participants reporting honestly about",
    "themselves. Read the record before trusting a `converged` result.",
    "",
  ].filter((l) => l !== null);
  writeFileSync(join(dir, "brief.md"), lines.join("\n"));
}

const entryFile = (goalId, entry) =>
  join(councilDir(goalId), `r${entry.round}-${entry.agent}.json`);

export function writeEntry(goalId, entry) {
  ensureCouncilDir(goalId);
  writeFileSync(entryFile(goalId, entry), JSON.stringify(entry, null, 2) + "\n");
}

/**
 * Round 1 is written only once both sides have submitted.
 *
 * This is what makes independence real rather than requested: before both have committed,
 * there is no file on disk for a late-starting agent to read, and council_await_peer is
 * the only path to the peer's answer.
 */
export function revealRound1(goalId, entries) {
  for (const entry of entries) writeEntry(goalId, entry);
}

export function summaryBlock(council, entries, verdict) {
  const byAgent = (agent) =>
    entries.filter((e) => e.agent === agent).sort((a, b) => b.round - a.round)[0] ?? null;

  const agents = [...new Set(entries.map((e) => e.agent))];
  const rounds = entries.length ? Math.max(...entries.map((e) => e.round)) : 0;

  // Only the final round is reported as open. A disagreement raised in round 2 and
  // dropped in round 3 is settled, and listing it as open forces the reader to work out
  // for themselves which objections still stand.
  const final = entries.filter((e) => e.round === rounds);
  const resolvedEarlier = entries.filter(
    (e) => e.round < rounds && e.verdict_on_peer === "DISAGREE",
  ).length;

  const unresolved = final
    .filter((e) => e.verdict_on_peer === "UNRESOLVED" && e.settling_test)
    .map((e) => `${e.agent} — would be settled by: ${e.settling_test}`);

  // `disagreement` holds the peer's quoted line, so the label names who is objecting and
  // to whom. Attributing the quote to its submitter reads exactly backwards.
  const disagreements = final
    .filter((e) => e.verdict_on_peer === "DISAGREE" && e.disagreement)
    .map((e) => {
      const target = agents.find((a) => a !== e.agent) ?? "peer";
      return `${e.agent} contests ${target}'s: ${e.disagreement}`;
    });

  const lines = [
    `COUNCIL ${council.goal_id} — ${council.status} after ${rounds} round${rounds === 1 ? "" : "s"}`,
    "",
    `Stopped because:  ${council.stop_reason ?? verdict?.reason ?? "not recorded"}`,
    "",
  ];

  for (const agent of agents) {
    const latest = byAgent(agent);
    lines.push(`${agent} position:  ${latest?.position ?? "(none)"}`);
  }

  lines.push("");
  lines.push(
    disagreements.length
      ? `Still disagreed at the end (round ${rounds}):`
      : "Still disagreed at the end:  nothing",
  );
  for (const d of disagreements) lines.push(`  - ${d}`);

  if (resolvedEarlier > 0) {
    lines.push(
      `  (${resolvedEarlier} earlier disagreement${resolvedEarlier === 1 ? "" : "s"} ` +
        "dropped before the end — see the record)",
    );
  }

  lines.push("");
  lines.push(unresolved.length ? "Unresolved, and what would settle it:" : "Unresolved:  none");
  for (const u of unresolved) lines.push(`  - ${u}`);

  lines.push("");
  if (council.status === "converged") {
    lines.push(
      "Note: `converged` reflects what the participants reported about themselves. It is",
    );
    lines.push("the weakest signal here. Read the record before acting on it.");
    lines.push("");
  }
  lines.push(`Full record:  ${councilDir(council.goal_id)}`);

  return lines.join("\n");
}

/**
 * The answer itself, as agreed. Separate from verdict.md on purpose: this is the file the
 * user reads, and the round record is the evidence behind it.
 */
export function writeAnswer(council, drafts) {
  const dir = ensureCouncilDir(council.goal_id);
  const final = drafts.length ? drafts[drafts.length - 1] : null;
  if (!final) return null;

  const unaddressed =
    final.verdict === "REVISE"
      ? final.revisions
      : drafts.find((d) => d.verdict === "REVISE" && d.revision === drafts.length)?.revisions;

  const lines = [
    `# ${council.question}`,
    "",
    final.answer,
    "",
    "---",
    "",
    `Drafted by ${final.author}, revision ${final.revision} of ${drafts.length}.`,
    final.verdict === "APPROVE"
      ? `Approved by ${final.reviewer}.`
      : final.verdict === "REVISE"
        ? `**Shipped without approval** — ${final.reviewer} still wanted changes:\n\n> ${unaddressed}`
        : final.verdict === "UNREVIEWED"
          ? "**Never reviewed** — the peer stopped responding. One model's answer, not two."
          : "Not reviewed — the review budget was spent.",
    "",
    `Reached after ${council.round} round${council.round === 1 ? "" : "s"} of debate ` +
      `(${council.status}: ${council.stop_reason ?? "no reason recorded"}).`,
    "",
    `Working: [verdict.md](./verdict.md)`,
  ];

  const path = join(dir, "answer.md");
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

export function writeVerdict(council, entries, verdict) {
  const dir = ensureCouncilDir(council.goal_id);
  const lines = [
    `# Verdict — ${council.goal_id}`,
    "",
    "```",
    summaryBlock(council, entries, verdict),
    "```",
    "",
    "## Question",
    "",
    council.question,
    "",
    "## Record",
    "",
  ];

  const rounds = [...new Set(entries.map((e) => e.round))].sort((a, b) => a - b);
  for (const round of rounds) {
    lines.push(`### Round ${round}`, "");
    for (const entry of entries.filter((e) => e.round === round)) {
      lines.push(`**${entry.agent}** — ${entry.position}`, "");
      if (entry.verdict_on_peer) {
        lines.push(`- Verdict on peer: \`${entry.verdict_on_peer}\``);
      }
      if (entry.disagreement) lines.push(`- Contests: ${entry.disagreement}`);
      if (entry.settling_test) lines.push(`- Would be settled by: ${entry.settling_test}`);
      for (const r of entry.reasoning) lines.push(`- ${r}`);
      for (const e of entry.evidence) lines.push(`  - evidence: ${e}`);
      lines.push(`- Confidence: ${entry.confidence}, new arguments: ${entry.new_arguments}`, "");
    }
  }

  writeFileSync(join(dir, "verdict.md"), lines.join("\n"));
  return join(dir, "verdict.md");
}

// ---------------------------------------------------------------------------
// The plan council
//
// The artifact here is the plan file itself, which the resolver edits in place. These
// files are the trail beside it: what was critiqued, what was applied, and what was
// rejected and why — the part of the manual loop that today survives only in scrollback.
// ---------------------------------------------------------------------------

export function writePlanBrief(council) {
  const dir = ensureCouncilDir(council.goal_id);
  const lines = [
    `# Plan council — ${council.goal_id}`,
    "",
    "## Plan under review",
    "",
    council.plan_path,
    "",
    "## Context",
    "",
    `- Project: ${council.project_path}`,
    council.git_branch ? `- Branch: ${council.git_branch}` : null,
    `- Started: ${council.started_at}`,
    `- Maximum rounds: ${council.max_rounds}`,
    "- codex critiques, claude applies. The plan file is edited in place.",
    "",
    "## How this ends",
    "",
    "It stops when codex reports the plan implementation-ready, when a decision turns out",
    `to be the user's to make, or after ${council.max_rounds} rounds.`,
    "",
    "From round 3 only Blocker and High findings hold the plan back. A thorough critic",
    "finds new Medium issues forever, because every revision creates new surface.",
    "",
  ].filter((l) => l !== null);
  writeFileSync(join(dir, "brief.md"), lines.join("\n"));
}

const planStepLines = (step) => {
  if (step.kind === "critique") {
    return [
      `### Round ${step.round} — critique by ${step.actor}`,
      "",
      `Findings: ${step.blockers} Blocker, ${step.highs} High, ${step.mediums} Medium, ` +
        `${step.lows} Low` +
        ((step.decisions ?? 0) > 0 ? ` — ${step.decisions} of them the user's to decide` : "") +
        `. Readiness: **${step.critic_readiness}**.`,
      "",
      step.critique,
      "",
      ...((step.decisions ?? 0) > 0
        ? ["**Decisions for the user**", "", step.decision_list ?? "", ""]
        : []),
    ];
  }
  if (step.kind === "decision") {
    return [`### Round ${step.round} — the user decided`, "", step.decision, ""];
  }
  return [
    `### Round ${step.round} — resolution by ${step.actor}`,
    "",
    `Implementation-ready: **${step.author_readiness}**.`,
    "",
    "**Plan fixes applied**",
    "",
    step.applied,
    "",
    "**Critiques rejected**",
    "",
    step.rejected ?? "None.",
    "",
    "**Additional issues integrated**",
    "",
    step.additional ?? "None.",
    "",
    "**Medium/Low findings deferred**",
    "",
    step.deferred ?? "None.",
    "",
    "**Needs user decision**",
    "",
    step.needs_user ?? "None.",
    "",
  ];
};

export function writePlanStep(goalId, step) {
  ensureCouncilDir(goalId);
  const name = `r${step.round}-${step.kind}-${step.seq}.md`;
  writeFileSync(join(councilDir(goalId), name), planStepLines(step).join("\n") + "\n");
}

export function planSummaryBlock(council, steps) {
  const critiques = steps.filter((s) => s.kind === "critique");
  const last = critiques.length ? critiques[critiques.length - 1] : null;
  const resolutions = steps.filter((s) => s.kind === "resolve");
  const rejected = resolutions.filter((s) => s.rejected).length;
  const pending = steps.filter((s) => s.kind === "resolve" && s.needs_user).at(-1);

  const lines = [
    `PLAN COUNCIL ${council.goal_id} — ${council.status} after ` +
      `${critiques.length} critique${critiques.length === 1 ? "" : "s"}`,
    "",
    `Plan:             ${council.plan_path}`,
    `Stopped because:  ${council.stop_reason ?? "not recorded"}`,
    "",
    last
      ? `Last critique:    ${last.blockers} Blocker, ${last.highs} High, ` +
        `${last.mediums} Medium, ${last.lows} Low — ${last.critic_readiness}`
      : "Last critique:    none",
    `Rounds with rejected critiques: ${rejected}`,
    "",
  ];

  if (council.status === "needs_user" && pending) {
    lines.push("Waiting on you to decide:", "", pending.needs_user, "");
    lines.push(
      "Answer it with plan_council_resume, or abandon the council with council_abandon.",
      "",
    );
  }

  if (council.status === "capped") {
    lines.push(
      "The cap stopped this, not the critic. The plan holds every fix applied so far, and",
      "the last critique above says what it still objects to. Read it before implementing.",
      "",
    );
  }

  lines.push(`Full trail:       ${councilDir(council.goal_id)}`);
  return lines.join("\n");
}

export function writePlanTrail(council, steps) {
  const dir = ensureCouncilDir(council.goal_id);
  const lines = [
    `# Plan council trail — ${council.goal_id}`,
    "",
    "```",
    planSummaryBlock(council, steps),
    "```",
    "",
    "## Plan under review",
    "",
    `${council.plan_path} — edited in place by the resolver, round by round.`,
    "",
    "## Record",
    "",
  ];
  for (const step of steps) lines.push(...planStepLines(step));

  const path = join(dir, "trail.md");
  writeFileSync(path, lines.join("\n"));
  return path;
}

// ---------------------------------------------------------------------------
// The implementation council
//
// The artifact is the working tree. These files are the trail beside it: what was claimed,
// what was verified and how, and what was rejected and why.
// ---------------------------------------------------------------------------

export function writeImplBrief(council) {
  const dir = ensureCouncilDir(council.goal_id);
  const lines = [
    `# Implementation council — ${council.goal_id}`,
    "",
    "## Task",
    "",
    council.task,
    "",
    "## Context",
    "",
    `- Project: ${council.project_path}`,
    council.git_branch ? `- Branch: ${council.git_branch}` : null,
    `- Base commit: ${council.base_ref}`,
    council.plan_path ? `- Plan: ${council.plan_path}` : "- Plan: none attached",
    council.plan_scope ? `- Scope in this council: ${council.plan_scope}` : null,
    council.dirty_at_open
      ? "- **The tree already had uncommitted changes when this opened**, so the diff from " +
        "base includes work that predates this task."
      : null,
    `- Started: ${council.started_at}`,
    `- Maximum rounds: ${council.max_rounds}`,
    "- claude implements, codex verifies. Codex never edits the code.",
    "",
    "## How this ends",
    "",
    "It stops when codex approves — which it cannot do while any Blocker or High finding",
    "stands, while any item in scope is unimplemented, while the report does not match the",
    "diff, or without saying what it actually verified.",
    "",
    "From round 3 only Blocker and High findings hold the work back. Unimplemented scope",
    "always does: complete is the point.",
    "",
  ].filter((l) => l !== null);
  writeFileSync(join(dir, "brief.md"), lines.join("\n"));
}

const implStepLines = (step) => {
  if (step.kind === "review") {
    return [
      `### Round ${step.round} — verification by ${step.actor}`,
      "",
      `Findings: ${step.blockers} Blocker, ${step.highs} High, ${step.mediums} Medium, ` +
        `${step.lows} Low. Gaps: ${step.gaps ?? 0}. Verdict: **${step.verdict}**.`,
      "",
      step.findings,
      "",
      "**Completeness**",
      "",
      step.coverage ?? "No plan attached, or nothing missing.",
      "",
      "**What was verified**",
      "",
      step.verification,
      "",
      `**Report matches the diff:** ${step.report_matches_diff}`,
      ...(step.mismatch ? ["", step.mismatch] : []),
      ...(step.plan_defect ? ["", "**Defect in the plan itself**", "", step.plan_defect] : []),
      "",
    ];
  }
  if (step.kind === "decision") {
    return [`### Round ${step.round} — the user decided`, "", step.decision, ""];
  }
  return [
    `### Round ${step.round} — implementation by ${step.actor}`,
    "",
    step.summary,
    "",
    "**Applied from the last review**",
    "",
    step.applied ?? "None.",
    "",
    "**Review points rejected**",
    "",
    step.rejected ?? "None.",
    "",
    "**Needs user decision**",
    "",
    step.needs_user ?? "None.",
    "",
  ];
};

export function writeImplStep(goalId, step) {
  ensureCouncilDir(goalId);
  writeFileSync(
    join(councilDir(goalId), `r${step.round}-${step.kind}-${step.seq}.md`),
    implStepLines(step).join("\n") + "\n",
  );
}

export function implSummaryBlock(council, steps) {
  const reviews = steps.filter((s) => s.kind === "review");
  const last = reviews.length ? reviews[reviews.length - 1] : null;
  const parked = steps.filter((s) => s.needs_user || s.plan_defect).at(-1);

  const lines = [
    `IMPL COUNCIL ${council.goal_id} — ${council.status} after ` +
      `${reviews.length} review${reviews.length === 1 ? "" : "s"}`,
    "",
    `Task:             ${council.task}`,
    `Base commit:      ${council.base_ref}`,
    council.plan_path
      ? `Plan:             ${council.plan_path}${council.plan_scope ? ` (scope: ${council.plan_scope})` : ""}`
      : "Plan:             none attached",
    `Stopped because:  ${council.stop_reason ?? "not recorded"}`,
    "",
    last
      ? `Last verdict:     ${last.verdict} — ${last.blockers} Blocker, ${last.highs} High, ` +
        `${last.mediums} Medium, ${last.gaps ?? 0} gap(s)`
      : "Last verdict:     none",
    "",
  ];

  if (last?.verification && council.status === "ready") {
    lines.push("Approved on this evidence:", "", last.verification, "");
  }

  if (council.status === "needs_user" && parked) {
    lines.push(
      "Waiting on you to decide:",
      "",
      parked.plan_defect ?? parked.needs_user,
      "",
      "Answer it with impl_council_resume, or abandon with council_abandon.",
      "",
    );
  }

  if (council.status === "capped") {
    lines.push(
      "The cap stopped this, not the critic. It never approved the work — read the last",
      "review above before treating this as done.",
      "",
    );
  }

  lines.push(`Full trail:       ${councilDir(council.goal_id)}`);
  return lines.join("\n");
}

export function writeImplTrail(council, steps) {
  const dir = ensureCouncilDir(council.goal_id);
  const lines = [
    `# Implementation council trail — ${council.goal_id}`,
    "",
    "```",
    implSummaryBlock(council, steps),
    "```",
    "",
    "## Task",
    "",
    council.task,
    "",
    "## Record",
    "",
  ];
  for (const step of steps) lines.push(...implStepLines(step));

  const path = join(dir, "trail.md");
  writeFileSync(path, lines.join("\n"));
  return path;
}

/** `YYYY-MM-DD-<slug>` from the question, with a suffix if that id is taken. */
export function makeGoalId(question, exists) {
  const date = new Date().toISOString().slice(0, 10);
  const slug =
    question
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .split("-")
      .slice(0, 6)
      .join("-") || "council";

  let id = `${date}-${slug}`;
  let n = 2;
  while (exists(id)) id = `${date}-${slug}-${n++}`;
  return id;
}
