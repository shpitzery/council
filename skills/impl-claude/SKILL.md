---
name: impl-council
description: Use when the user wants code written and then actually verified — "/impl-council implement X", "fix Y and have codex check it", "make this change and verify it". You do the work, Codex verifies the real diff against the plan and the tests, and you apply what holds. Stops when Codex approves.
argument-hint: '<what to implement or verify> [plan:<path>] [scope:<slice>] [base:<git-ref>] · start Codex only after I say "Start Codex now"'
---

# Implementation council

You write the code. Codex verifies it — against the diff, against the plan if there is one,
and by actually checking rather than reading. You apply what holds, push back on what does
not, and it looks again.

The other two modes run before code exists. This one runs after, and it is the only one where
approval can be backed by something executed.

The user runs this skill in both windows.

## What you were given

```
/impl-council <what to implement or verify> [plan:<path>] [scope:<slice>] [base:<git-ref>]
```

Nothing is parsed into arguments — the whole line arrives as text and you pick out what you
need. Quotes are never required. The `plan:` `scope:` `base:` markers are a convention for
saying which is which, not syntax; a user who writes them as a sentence means the same thing.

| Argument | Required | Notes |
|---|---|---|
| the task | **yes** | in the user's words; becomes `task` and is what completeness is judged against when there is no plan |
| `plan:` | no | the plan being implemented. Completeness is then judged against it instead |
| `scope:` | **when `plan:` is given** | which slice — "W1 only", "sections 1–3" |
| `base:` | **when the work is already committed** | `HEAD~1`, a branch, a commit |

### When something is missing

**No task.** Do not invent one. If the conversation makes the work unambiguous — the user
just asked for a change, or says "verify what you did" — use that, and say in one line what
you recorded as the task so they can correct it. If it is not unambiguous, ask. A wrong task
is not cosmetic: it is the yardstick Codex judges completeness against when no plan is
attached.

**`plan:` given, no `scope:`.** Ask, once: the whole plan, or a named part? Do not assume the
whole plan. Guessing wrong floods every round with gaps that were never meant to be done yet,
and the real ones drown.

**No `plan:` at all.** Fine — that is the normal case for a change with no plan behind it. Do
not go looking for a plan file to attach. Completeness is then judged against the task text.

**No `base:`.** Check before assuming, since it is not visible from the task text: run
`git status --porcelain` and `git log --oneline -3` in the project. Uncommitted work needs no
base; work you already committed needs one. If the user's words point at a commit — "verify
the last commit", "check what I pushed" — pass `base_ref` accordingly rather than finding out
from an empty diff two calls later.

**Nothing at all — bare `/impl-council`.** Ask what to verify or implement. Do not open a
council on a guess; an implementation council on the wrong task blocks every other mode until
someone abandons it.

## Telling the user when to start Codex

The user runs the skill in the Codex window by hand, and they cannot see what is happening
in yours. **They wait for you to say so.**

Say it once, on its own line, exactly: **`Start Codex now.`**

**Say it after `impl_council_report` succeeds — not after `impl_council_open`.** This mode
differs from the other two on purpose:

- Codex has nothing to verify until the report and the diff exist. Started earlier it only
  waits.
- Waiting costs it. Codex's thirty-minute budget runs from the last thing that happened, and
  its own join counts as one. Bring it in before you start coding and the clock is running
  while you write; a change that takes forty minutes times its wait out for no reason.

So: open, report what was `cleared`, then **do the work in silence**. Report. Then hand over.

When the work already exists and you are only having it verified, open and report land back
to back — the handoff comes seconds later, and that is fine. Same rule, nothing special.

Never say it before the council exists. Codex's skill refuses to open one itself.

## The loop

1. **`impl_council_open`** — `agent: "claude"`, `task` in the user's words, `project_path`,
   and `plan_path` plus `plan_scope` when a plan exists.

   **Call this before you touch anything.** It records the current commit as the base, and
   every diff is measured from it.

   **Unless the work already exists** — the user asking you to verify something you just
   built is a normal way to use this, not a mistake. Then the base has to sit *before* the
   work:

   | The work is | Pass |
   |---|---|
   | not written yet | nothing — the default `HEAD` is right |
   | written, uncommitted | nothing — `HEAD` still predates it, and the diff picks it up |
   | already committed | `base_ref` — `HEAD~1`, a branch, or the commit before you started |

   Get this wrong on committed work and the base contains the change: the diff is empty and
   Codex verifies nothing. The report call warns you when that happens — do not push past it.

   It also clears councils a dead session left behind, in `cleared`. Say what was cleared —
   but **do not hand over to Codex yet**; that comes after step 3. If the reply carries
   `resuming`, stop and ask whether to resume or start over — `fresh: true` discards.

   **Report `max_rounds` there too — `Cap: 10 rounds.`** It is this council's cap, fixed when
   it was opened, not whatever this file says today. A number the user does not expect means
   the server process predates a change to the default: it loads once per window and never
   reloads, so a window left open across a change keeps the old cap. Restarting this window
   fixes it for the next council; one carried over by `resuming` keeps the cap it has.

2. **Do the work.** Normally, as you would without any of this. Skip this step when the work
   already exists and you are having it verified.

3. **`impl_council_report`** — what you changed and why, file by file where it matters. If
   the tree was already dirty when you opened, say whether those changes are the work under
   review or something unrelated that will otherwise be verified by accident.

   **On round 1 only, this is where you hand over**: once the report lands, say `Start Codex
   now.` on its own line. Later rounds need nothing — Codex is already in the loop.

4. **`impl_council_await`** — until Codex's verification lands. `retry: true` means call
   again, and keep calling.

5. Read `latest_review`. **Run your `superpowers:receiving-code-review` skill** against it:
   verify each point against the code, apply what holds, push back on what does not with a
   reason. Then report again — `applied` for what you took, `rejected` for what you did not
   and why.

6. Back to step 4.

## Naming the scope matters

When you pass a `plan_path`, pass `plan_scope` too unless the whole plan is genuinely meant
to be done now. A plan with gates W0–W7 is not one sitting's work, and without a scope Codex
reports the other six gates as missing every round — the real gaps drown in noise.

## Your report is checked against the diff

Codex reads the actual diff, and "does the report match it" is a finding in its own right.
Anything you touched in passing and did not mention counts against you, as does anything you
claimed and did not do.

So: mention everything. A refactor you did on the way, a file you reformatted, a helper you
deleted. Not because it is wrong to have done it — because an unmentioned change is
indistinguishable from one you were hiding.

## What Codex will refuse to approve

Worth knowing, so you are not surprised by a round that could have ended:

- any Blocker or High finding still standing
- **any item in the named scope unimplemented** — and this one never expires. Medium findings
  stop blocking from round 3; incompleteness never does.
- a report that does not match the diff
- an approval with no account of what was actually checked

## Rules the server cannot enforce

**Never guess at a decision that is the user's.** Put it in `needs_user_decision` and the
council parks. Guessing so the loop can continue means settling their decision for them,
invisibly, inside an automation.

When they answer, call **`impl_council_resume`**. The same round comes back to you.

**Codex may park the council over the plan itself** — `plan_defect`, when a step cannot work
as written. Do not fix the plan to unblock it. The plan already survived its own council;
rewriting it mid-implementation with no critic on the change is how a reviewed plan quietly
stops being reviewed. Show the user and let them rule.

**A rejection needs its reason.** `receiving-code-review` already requires you to verify
before implementing and to push back with technical reasoning. Carry that reasoning into
`rejected` — a review point dropped silently is how a real Blocker gets lost.

## Waiting

**Keep calling `impl_council_await` while it answers `retry: true`.** Each call returns after
about 50 seconds; that is the tool's limit, not a verdict about Codex. Verifying a change
against a real codebase takes many minutes — the server allows thirty and ends the wait
itself.

**Never say Codex is absent unless `peer_joined` is `false`.** That field distinguishes
"still working" from "never triggered", which look identical from here.

## How it ends

`ready`, `capped` and `error` all stop blocking on their own; only `active` and `needs_user`
hold the next council up.

- **`ready`** — Codex verified it. Tell the user what was checked, not just that it passed.
- **`needs_user`** — parked on a decision. Not an ending; resume it.
- **`capped`** — rounds ran out without approval. **Say plainly that Codex never approved**,
  and point at the last review. Do not present capped work as done.
- **`error`** — Codex stopped responding. Your code is untouched by this.

Call **`impl_council_close`** and lead with the outcome and the evidence.

## When something goes wrong

**One council at a time, across all three modes.** `council_abandon` is the only release —
closing renders a record and releases nothing.

**No subagents.** Not for the loop, and not for the work Codex is going to verify under your
name.
