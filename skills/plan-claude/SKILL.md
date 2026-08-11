---
name: plan-council
description: Use when the user wants an implementation plan critiqued until it is ready to build — "get codex to review this plan", "run the plan past codex", "/plan-council". Automates the critique-plan / plan-critique-resolver loop against a Codex session, editing the plan file in place, and stops when the critic says the plan is implementation-ready.
argument-hint: '<plan-path> [fresh] · start Codex only after I say "Start Codex now"'
---

# Plan council

You wrote the plan. Codex attacks it. You answer, edit the plan file, and it attacks the
revision — until it reports the plan implementation-ready, or a decision turns out to be
the user's, or ten rounds are up.

This replaces a loop the user runs by hand: paste the plan to Codex, paste its critique
back, run the resolver, repeat. You are the author, always. Codex is the critic, always.

The user runs this skill in both windows.

## What you were given

```
/plan-council <plan-path> [fresh]
```

| Argument | Required | Notes |
|---|---|---|
| the plan path | **yes** | the file Codex critiques and you edit in place |
| `fresh` | no | discard a council already running on this plan and start at round 1 |

### When something is missing

**No plan path.** If the conversation names exactly one plan file, use it and say which one
you took. Otherwise **ask**.

Do not go looking. Listing a plans directory and picking the newest is exactly what went
wrong once already — Codex, with no council open, found a plan file itself and opened a
council on its guess. It guessed right that time. A council on the wrong plan edits the wrong
file in place, and the resolver's edits are not undoable.

**The plan does not exist at that path.** Say so and stop. This mode revises a plan; it does
not write one. If there is no plan yet, that is a different job.

**Bare `/plan-council` with nothing in the conversation.** Ask which plan. Do not open a
council to find out — an open council blocks every other mode until it is finished or
abandoned.

## Telling the user when to start Codex

The user runs the skill in the Codex window by hand, and they cannot see what is happening
in yours. **They wait for you to say so.**

Say it once, on its own line, exactly: **`Start Codex now.`**

Say it **after `plan_council_open` succeeds and after you have reported what was `cleared`**
— and, if the reply carried `resuming`, only once the user has answered resume-or-start-over.
The critic moves first in this mode, so there is nothing else to do first: open, report the
state, hand over.

Never say it before the council exists. Codex's skill refuses to open one — told to start
with nothing open, it will sit there telling the user to run your window instead.

## The loop

1. **`plan_council_open`** — `agent: "claude"`, plus `plan_path` and `project_path`.

   Opening also clears councils a dead session left behind, and lists them in `cleared`.
   **Say what was cleared, then give the handoff line** — one line each, then `Start Codex
   now.` on its own line. That handoff is the point: they trigger the second window only once
   this one is ready for it.

   **If the reply carries `resuming`, stop there and ask.** A council on this plan already
   has work in it. Show the user the round, how old it is, what the waiting critique found,
   and whether `plan_changed_since_critique` is true — then ask: resume, or start over?
   Starting over means calling `plan_council_open` again with `fresh: true`, which discards
   that council and everything in it.

   Do not resolve, critique or abandon anything before they answer. Resuming without saying
   so is how a session ends up applying a critique the user thought was gone; starting over
   without asking throws away work Codex may have spent ten minutes on.

   `plan_changed_since_critique: true` matters most: the critique was written against a
   version of the plan that no longer exists, so parts of it may object to text you have
   already rewritten. Lead with that when it is true.
2. **`plan_council_await`** — blocks until Codex's critique lands. **`retry: true` means
   call it again, and keep calling.** See below — this is the step that goes wrong.
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

## Waiting is most of this skill

**Keep calling `plan_council_await` while it answers `retry: true`.** Each call returns
after about 50 seconds; that is the tool's limit, not a verdict about Codex. The server ends
the wait itself and tells you when it has. Three polls is not "Codex isn't coming" — it is
two and a half minutes.

**A real critique takes many minutes.** Codex is reading your plan against the actual
codebase — source files, contract docs, git state. That is the whole value of this loop.
Expect ten minutes; the server allows thirty.

**Never announce that Codex is absent unless `peer_joined` is `false`.** That field is why
it exists: it distinguishes "still working" from "never triggered", which are identical from
where you sit. Reporting a working peer as missing is a false statement to the user, and it
ends the run for no reason. It has already happened once.

**If the wait hands back saying Codex has not joined, the council is still open.** Tell the
user to start the skill in that window, then call `plan_council_await` again. Do not abandon
it and do not open a fresh one — the council is fine, the other window just was not running
yet.

## Keep it a plan

A plan is what an implementer works from. It is not a specification, and this loop pushes
hard toward turning it into one: Codex writes every finding with a `Fix:` clause, nothing in
ten rounds ever *removes* anything, and each round critiques the longer plan the last one
produced. One real run reached 1797 lines this way, and nobody noticed until it was over.

**Integrate each finding as the smallest change that settles it.** An edited line. A
decision recorded in a sentence. A finding is not a licence to add a section.

**When a finding genuinely needs a frozen table or an exact sequence, record the decision and
say where the detail belongs** — the contract doc, the ABI table, the test file. Do not inline
it. "Exception order is frozen: bad_alloc rethrown first, then SchemaError → 400" is a plan
step. Three paragraphs of ordering is a specification that has wandered into one.

**Every reply carries `plan_lines`, `plan_lines_added_last_step` and
`plan_lines_added_total`.** Read them. If a round added more than it changed, say so to the
user rather than carrying on — they may want to stop and prune before round 3 makes it worse.

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

Once it ends, the council stops blocking on its own — `ready`, `capped` and `error` all
release. Only `active` and `needs_user` hold the next one up. `plan_council_close` writes
the record; it does not release anything.

- **`ready`** — Codex reports the plan implementation-ready. This is the real result. From
  round 3 on, only Blocker and High findings hold the plan back; a critic that keeps finding
  Medium issues forever cannot stall it past that.
- **`needs_user`** — parked on the user's decision. Not an ending; resume it.
- **`capped`** — ten rounds went by without Codex reporting ready. The plan holds every fix
  applied so far and the last critique says what Codex still objects to. **Tell the user the
  critic never signed off**, and point them at that critique. Do not present a capped plan
  as ready.
- **`error`** — Codex stopped responding. The plan file keeps every fix already applied.

Call **`plan_council_close`** at the end. Lead with the outcome and the plan file — the
trail at `record_path` is the working behind it.

## When something goes wrong

**One council at a time, across both modes.** A plan council blocks `/council` and the other
way round. **`council_abandon` is the only release** — call it with a reason if the plan was
wrong, Codex never joined, or the user changed their mind. `council_close` and
`plan_council_close` render records; they release nothing, so calling them on a blocking
council leaves you exactly as blocked as before.

**No subagents, anywhere in this.** Do not hand the council loop to the Agent tool, and do
not let the resolving step spawn one either — `plan-critique-resolver` now does its
code-grounded verification itself, for the same reason: a subagent starts cold, re-derives
context you already hold, and returns findings you have to re-check.
