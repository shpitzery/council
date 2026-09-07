---
name: council
description: Only when the user explicitly types /council in this window. Do NOT trigger on a general request for a second opinion, a review, or "what would claude say" — this is one half of a two-window loop, and unlike the other two modes you CAN open one here, so a wrong guess creates a real council that blocks every mode until someone abandons it.
---

# Council

You and Claude answer the same question independently, then critique each other for a
bounded number of rounds. Both of you already hold context the other lacks. The point is
not to agree — it is to surface where you disagree and why.

The user runs this skill in both windows. You are one participant, not the chairman.

## Before anything else

**Did the user type `/council` in this window?** If not, stop and say so — then do the work
they actually asked for.

This skill is half of a loop across two windows, and the user starts each half by hand. A
request to get a second opinion, review something, or say what Claude would think is not a
request for it: answer it yourself. Reaching for this skill on that phrasing costs the user
a wrong turn and, here alone, opens a real council that blocks every mode until someone
abandons it — the other two modes refuse to let you start one, this one does not.

## The loop

1. **`council_open`** — `agent: "codex"`, plus `question` and `project_path` if you are
   first. If Claude already opened one, you join it automatically.
2. **`council_submit`** — your answer. On round 1 you have not seen Claude's answer and must
   not guess at it.

   **Write to the caps the first time.** The server rejects an oversized field outright and
   the whole call is lost, composing included:

   | Field | Cap |
   | --- | --- |
   | `position` | 300 characters — one sentence carrying the claim, nothing else |
   | `reasoning` | 4 entries, 2000 characters each |
   | `evidence` | 6 entries, 2000 characters each |
   | `disagreement`, `settling_test` | 2000 characters |

   `position` is the claim; the argument goes in `reasoning`. If four reasons or six pieces
   of evidence will not hold what you have, that is a signal to cut, not to retry.
3. **`council_await_peer`** — blocks until Claude answers, then returns it. If the reply has
   `retry: true`, call it again. This is the only way to read Claude.
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

**Pass `project_path` explicitly.** Your working directory is a per-conversation scratch
folder, not the project — the server cannot infer it.

## Rules the server cannot enforce

The tool schema rejects a `DISAGREE` with nothing quoted and an `UNRESOLVED` with no
settling test. It cannot judge whether what you wrote is honest. That part is yours.

**Evidence means evidence.** A `file:line`, command output, a test result, or a quote from
a document. "I think", "it's cleaner", and "best practice" are not evidence. If your
`evidence` array would be an opinion restated, you do not have evidence — say so.

**Never agree by assertion.** "Good point, you're right" closes nothing. If Claude changed
your mind, state the reason independently, in your own words, citing what convinced you.
If you cannot, mark it `UNRESOLVED` and write the check that would settle it.

**Disagree specifically.** Quote the line you contest, not the general thrust. "I disagree
with the approach" is not a disagreement.

**Do not soften to reach agreement.** A council that converges because both sides gave way
is worse than useless — it manufactures false confidence. `UNRESOLVED` is a good outcome.
Being cornered is a good outcome.

**No subagents.** Do not use `spawn_agent` for any part of this. A subagent lacks the
session context that is the whole reason you were asked, and its answer would be returned
under your name — the user would think they got your opinion when they got a stranger's.

**Do not create or modify a goal.** `create_goal` and `update_goal` are out of bounds here.
A council is one consultation inside whatever you are already working on; there is one goal
per thread, and taking it would displace the user's own.

## When something goes wrong

**One council at a time**, and a council is not finished when the arguing stops — it is
finished when the answer is written and reviewed. `council_open` returns any council you
still owe a draft or review on, and says which you owe. Finish it.

**If it cannot be finished** — the peer never joined, the question was wrong, the user
changed their mind — call **`council_abandon`** with a reason. The record survives, the peer
is released, and you can start a new one. Do not leave a council half-finished: it blocks
every future council on your side.

**If the peer stops responding mid-draft**, the wait ends by itself after five minutes.
Whatever draft exists becomes the answer, marked as never reviewed. Tell the user plainly
that it is one model's answer rather than two.

**The round cap is the only honest stopping rule.** The council also stops when both sides
report agreement or report adding nothing new — but those read what you and Claude say about
yourselves. Do not treat `converged` as proof of anything. Say so to the user when it
happens.

**If Claude never joins**, the council times out after 5 minutes and is marked `error`. The
record still renders. Tell the user Claude was never triggered in its window.

## What to tell the user at the end

Lead with the `answer` from `council_close` — that is the thing they asked for. Mention
that the full record and the round-by-round working are in `verdict.md` at `record_path`.

Do not lead with the summary block. It is a status report about a process the user does
not care about.
