---
name: plan-council
description: Only when the user explicitly types /plan-council in this window, after Claude has told them to start you. Do NOT trigger on a general request to review, critique, or check a plan — that is ordinary work, and critique-plan is the skill for it. This is one half of a two-window loop that Claude must open first.
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

## Before anything else

**Did the user type `/plan-council` in this window?** If not, stop and say so — then do the
work they actually asked for.

This skill is half of a loop across two windows, and the user starts each half by hand. A
request to review, critique, or check a plan is not a request for it: that is what your
`critique-plan` skill is for, on its own. Reaching for this skill on that phrasing costs the
user a wrong turn.

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
   Readiness line, and `decisions`/`decision_list` ← the split below.
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
swelling every round, say so — **in the `Readiness` line, not as a Medium finding.** From
round 3 a Medium is deferred by rule, so length filed at that severity is guaranteed to be
read and dropped. One real council filed it three rounds running as a Medium while the plan
went 593 → 624 → 706 lines.

**Say when a finding is a regression from the last round's fix.** You are the only one
holding both versions. "New since round 5, introduced by the fix to High 2" turns a count
into something Claude can act on; without it, four findings look the same whether the plan is
converging or being churned. One nine-round council spent rounds 6, 7 and 8 entirely on
defects the previous round's repairs had introduced.

The server rejects `Ready` while you report Blocker or High findings — but it cannot tell
whether a Blocker was quietly filed as Medium instead. That part is yours.

## Defects and decisions

`critique-plan` splits your Blocker and High findings two ways. Carry that split here:
`decisions` is how many of them are decisions, and `decision_list` is those questions with
their options, written for the user to answer.

**Anything above zero parks the council.** The round stops, Claude shows the user your
questions, and nothing moves until they answer. That is the point — a decision is not work
Claude can do, and a council that lets the author guess at one spends its rounds designing
the plan instead of checking it. One real council spent six rounds and an hour that way: four
of its nine round-1 findings were unmade decisions, the author guessed at all four, and every
guess produced the next round's findings.

**It is not a way to hand back work you would rather not think about.** The test from
`critique-plan` holds here: if you cannot name two options you would defend, it is a defect
with one right answer and the author should fix it.

Only Blocker and High findings count. A Medium decision belongs in the critique text, and the
server rejects a `decisions` count larger than the blocking findings it is drawn from.

**Ready is impossible while a decision stands** — the server enforces it, and the severity
gate does not retire one. Nothing Claude does makes an unmade decision go away.

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
