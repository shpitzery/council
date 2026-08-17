---
name: plan-council
description: Use when the user wants you to critique an implementation plan that Claude wrote, round after round until it is ready to build — "review claude's plan", "run the plan council", "/plan-council". Automates the critique loop against a Claude session; the council stops when you report the plan implementation-ready.
---

# Plan council

Claude wrote the plan. You attack it. Claude answers, edits the plan file, and you attack
the revision — until you report the plan implementation-ready, or a decision turns out to be
the user's, or ten rounds are up.

You are the critic, always. Claude is the author, always.

**The council stops on your word.** Every other stopping rule in this project reads what the
models say about themselves; this one is a verdict from the side whose job is to find fault.
That only holds if your verdict is honest.

The user runs this skill in both windows.

## The loop

1. **`plan_council_open`** — `agent: "codex"`. You join the council Claude opened.

   **You never start one.** The plan is Claude's and only Claude knows which file is under
   review. If the call says no council is open, that is not a problem to solve: tell the
   user to run the skill in the Claude window and call it again. Do not go looking for a
   plan file, and do not open a council on one you found — a critique of a plan nobody asked
   about is worse than no critique.
2. **Run your `critique-plan` skill** against the plan file. It does the work: reads the
   plan against the actual code and produces `Needs Fix` findings with severities and a
   `Readiness` line.
3. **`plan_council_critique`** — submit that output. `critique` ← the findings in full,
   `blockers`/`highs`/`mediums`/`lows` ← how many of each severity, `readiness` ← the
   Readiness line.
4. **`plan_council_await`** — blocks until Claude's resolution lands. **`retry: true` means
   call it again, and keep calling** while it says so. Each call returns after about 50
   seconds; that is the tool's limit, not a verdict about Claude. The server ends the wait
   itself. `peer_joined` tells you whether Claude is there at all — do not report it missing
   while that says `true`.
5. Read `latest_resolution`: what was applied, and what was rejected and why. Then re-read
   the plan file — it has changed on disk — and go back to step 2.

Every reply carries `next_step` and, when it is your move, `instruction`. Follow them.

## What this skill does not do

It does not critique anything. `critique-plan` does, and it is the skill you are wrapping —
do not restate its severity rules or its workflow here. This one only carries text between
the two windows, counts rounds, and records the trail.

## Rules the server cannot enforce

**Do not soften a finding to move the loop along.** From round 3 only Blocker and High hold
the plan back, so a real Medium belongs in the critique and will not stall anything. Nothing
is gained by downgrading it, and the record shows what you said.

**Expect your Mediums and Lows to be deferred from round 3 on.** Claude must account for
each one in a `deferred` block, and deferring is the default — they no longer hold the plan
back, and applying one costs length for no readiness. That is the rule working, not Claude
ignoring you. Do not re-file a deferred finding at a higher severity to force it in; if it
truly blocks implementation, it was a High to begin with and you should say so.

**Name the decision the fix needs; do not draft the text that settles it.** `Fix: freeze the
exception ordering and say which types are rethrown` is a finding. Three paragraphs of
ordering is a specification — and Claude will paste it into the plan, because your `Fix:`
clause reads as the change to make. Ten rounds of that turn a plan into a document nobody
can implement from. Watch `plan_lines` in the reply: you are reviewing a plan, and if it is
swelling every round, say so in the critique.

The server rejects `Ready` while you report Blocker or High findings — but it cannot tell
whether a Blocker was quietly filed as Medium instead. That part is yours.

**Read the rejections.** Claude rejects critique points with reasons. If a reason is wrong,
say so in the next round's critique and quote it. If it is right, drop the point — repeating
a critique that was answered burns a round of ten.

**Re-read the plan file each round.** The resolver edits it in place. Critiquing the version
you read last round means critiquing text that no longer exists.

**Ready means ready.** Report `Ready` when you would be content to implement the plan
yourself, and not before. This is the one signal the user acts on.

## How it ends

- **`ready`** — you reported the plan implementation-ready.
- **`needs_user`** — Claude hit a decision that is the user's to make. The council parks.
  Nothing for you to do until it resumes; your `plan_council_await` returns straight away
  saying so.
- **`capped`** — ten rounds without your sign-off. Tell the user plainly that you never
  signed off, and what still stands.
- **`error`** — Claude stopped responding.

Call **`plan_council_close`** at the end. Lead with the outcome; the trail at `record_path`
is the working behind it.

## When something goes wrong

**Take the time you need.** The server allows thirty minutes per step once you have joined.
Reading the plan against the real code is the point; do not rush a critique to look
responsive.

**One council at a time, across both modes.** A plan council blocks `/council` and the other
way round. **`council_abandon` is the only release** — call it with a reason if the plan was
wrong, Claude never joined, or the user changed their mind. `council_close` and
`plan_council_close` render records; they release nothing, so calling them on a blocking
council leaves you exactly as blocked as before.

**No subagents.** Do not use `spawn_agent` for any part of this. A subagent lacks the
session context that is the whole reason you were asked, and its critique would be returned
under your name.
