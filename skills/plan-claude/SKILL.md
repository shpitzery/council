---
name: plan-council
description: Use when the user wants an implementation plan critiqued until it is ready to build — "get codex to review this plan", "run the plan past codex", "/plan-council". Automates the critique-plan / plan-critique-resolver loop against a Codex session, editing the plan file in place, and stops when the critic says the plan is implementation-ready.
---

# Plan council

You wrote the plan. Codex attacks it. You answer, edit the plan file, and it attacks the
revision — until it reports the plan implementation-ready, or a decision turns out to be
the user's, or four rounds are up.

This replaces a loop the user runs by hand: paste the plan to Codex, paste its critique
back, run the resolver, repeat. You are the author, always. Codex is the critic, always.

The user runs this skill in both windows.

## The loop

1. **`plan_council_open`** — `agent: "claude"`, plus `plan_path` and `project_path`. If
   Codex opened it first you join it.
2. **`plan_council_await`** — blocks until Codex's critique lands. `retry: true` means call
   it again.
3. Read `latest_critique`. **Run your `plan-critique-resolver` skill** with that critique
   text and the plan file. It does the work: verifies each point against the code, edits
   the plan file surgically, and produces the five output blocks.
4. **`plan_council_resolve`** — submit those blocks. `applied` ← Plan Fixes Applied,
   `rejected` ← Critiques Rejected, `additional` ← Additional Issues Integrated,
   `needs_user_decision` ← Needs User Decision, `readiness` ← Implementation-Ready Decision.
5. Back to step 2 for the next round.

Every reply carries `next_step` and, when it is your move, `instruction`. Follow them.

## What this skill does not do

It does not critique, resolve, or edit anything. `plan-critique-resolver` does all of that
and is the skill you are wrapping — do not restate its rules here or work around them. This
one only carries text between the two windows, counts rounds, and records the trail.

## Rules the server cannot enforce

**Never guess at a `Needs User Decision`.** If the resolver raises one, put it in
`needs_user_decision` verbatim. The council parks, and you stop and hand the question to the
user. Guessing so the loop can continue is the one failure that makes this whole mode worse
than doing it by hand — you would be settling the user's decision on their behalf, invisibly,
inside an automated loop.

When they answer, call **`plan_council_resume`** with what they said. The same round comes
back to you: apply their decision with the resolver, then `plan_council_resolve` again.

**A rejection needs its reason.** The resolver already produces one for every critique it
rejects. Carry it across. "Rejected" with no reason is how a real Blocker gets lost.

**Do not report `READY` to be finished.** Your readiness is recorded, but it is not the stop
signal — Codex's is. Reporting READY over a Blocker you did not fix just puts a false claim
in the trail.

## How it ends

- **`ready`** — Codex reports the plan implementation-ready. This is the real result. From
  round 3 on, only Blocker and High findings hold the plan back; a critic that keeps finding
  Medium issues forever cannot stall it past that.
- **`needs_user`** — parked on the user's decision. Not an ending; resume it.
- **`capped`** — four rounds went by without Codex reporting ready. The plan holds every fix
  applied so far and the last critique says what Codex still objects to. **Tell the user the
  critic never signed off**, and point them at that critique. Do not present a capped plan
  as ready.
- **`error`** — Codex stopped responding. The plan file keeps every fix already applied.

Call **`plan_council_close`** at the end. Lead with the outcome and the plan file — the
trail at `record_path` is the working behind it.

## When something goes wrong

**One council at a time, across both modes.** A plan council blocks `/council` and the other
way round. `council_abandon` is the release for either — call it with a reason if the plan
was wrong, Codex never joined, or the user changed their mind.

**No subagents for the protocol itself.** Do not hand the council loop to the Agent tool.
`plan-critique-resolver` calling its own `plan-readiness-verifier` is that skill's business
and stays exactly as it is.
