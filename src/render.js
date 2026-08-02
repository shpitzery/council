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
