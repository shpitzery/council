---
name: council
description: Use when the user wants a second model to check, challenge, or help decide something — "ask codex", "get a second opinion", "have them argue this out", "/council". Runs bounded critique rounds between this session and a Codex session, each keeping its own context, and returns a verdict with the disagreements intact.
---

# Council

You and Codex answer the same question independently, then critique each other for a
bounded number of rounds. Both of you already hold context the other lacks. The point is
not to agree — it is to surface where you disagree and why.

The user runs this skill in both windows. You are one participant, not the chairman.

## The loop

1. **`council_open`** — `agent: "claude"`, plus `question` and `project_path` if you are
   first. If Codex already opened one, you join it automatically.
2. **`council_submit`** — your answer. On round 1 you have not seen Codex's answer and must
   not guess at it.
3. **`council_await_peer`** — blocks until Codex answers, then returns it. If the reply has
   `retry: true`, call it again. This is the only way to read Codex.
4. Read their answer. Go back to step 2 for the next round.
5. When a reply says the council stopped, call **`council_close`** and show the user the
   `summary`.

Every reply carries an `instruction` field for the round you are about to answer. Follow it.

## Rules the server cannot enforce

The tool schema rejects a `DISAGREE` with nothing quoted and an `UNRESOLVED` with no
settling test. It cannot judge whether what you wrote is honest. That part is yours.

**Evidence means evidence.** A `file:line`, command output, a test result, or a quote from
a document. "I think", "it's cleaner", and "best practice" are not evidence. If your
`evidence` array would be an opinion restated, you do not have evidence — say so.

**Never agree by assertion.** "Good point, you're right" closes nothing. If Codex changed
your mind, state the reason independently, in your own words, citing what convinced you.
If you cannot, mark it `UNRESOLVED` and write the check that would settle it.

**Disagree specifically.** Quote the line you contest, not the general thrust. "I disagree
with the approach" is not a disagreement.

**Do not soften to reach agreement.** A council that converges because both sides gave way
is worse than useless — it manufactures false confidence. `UNRESOLVED` is a good outcome.
Being cornered is a good outcome.

**No subagents.** Do not use the Agent tool for any part of this. A subagent lacks the
session context that is the whole reason you were asked, and its answer would be returned
under your name — the user would think they got your opinion when they got a stranger's.

## Limits worth knowing

**One council at a time.** Opening a second while one is active is rejected. Close the
first.

**The round cap is the only honest stopping rule.** The council also stops when both sides
report agreement or report adding nothing new — but those read what you and Codex say about
yourselves. Do not treat `converged` as proof of anything. Say so to the user when it
happens.

**If Codex never joins**, the council times out after 5 minutes and is marked `error`. The
record still renders. Tell the user Codex was never triggered in its window.

## What to tell the user at the end

Show the `summary` from `council_close` as-is. Then add your own read in a sentence or two:
what you would do, and whether the disagreement that remains actually matters for their
decision. If nothing was resolved, say that plainly rather than dressing it up.
