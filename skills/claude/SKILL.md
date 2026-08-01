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
5. When a reply says the council stopped, the rounds are over but the work is not — go to
   the drafting phase below.

Every reply carries an `instruction` field for the round you are about to answer. Follow it.

## The drafting phase

The round record shows what each of you argued. It does not answer the question. So one of
you writes the answer and the other reviews it. The reply that ends the rounds tells you
which role you have.

**If you are the drafter:** call **`council_draft`** with the answer the user actually
asked for — what you would tell them if they had asked you privately. Prose, not a summary
of the debate. Then `council_await_peer` for the review. If it comes back `REVISE`, draft
again addressing what they quoted.

**If you are the reviewer:** `council_await_peer` until the draft arrives, then
**`council_review`**. `APPROVE` only if you would be content to have written it yourself.
`REVISE` if it overstates agreement, drops something unresolved, or buries the first
action — and quote the part you want changed.

The budget is two reviews. After that the latest draft ships as it stands, with any
remaining objection recorded rather than dropped.

When it is final, call **`council_close`** and show the user the `answer`. The `summary` is
the working behind it — offer it, do not lead with it.

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

Lead with the `answer` from `council_close` — that is the thing they asked for. Mention
that the full record and the round-by-round working are in `verdict.md` at `record_path`.

Do not lead with the summary block. It is a status report about a process the user does
not care about.
