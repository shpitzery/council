---
name: impl-council
description: Use when the user wants code written and then actually verified — "/impl-council implement X", "fix Y and have codex check it", "make this change and verify it". You do the work, Codex verifies the real diff against the plan and the tests, and you apply what holds. Stops when Codex approves.
---

# Implementation council

You write the code. Codex verifies it — against the diff, against the plan if there is one,
and by actually checking rather than reading. You apply what holds, push back on what does
not, and it looks again.

The other two modes run before code exists. This one runs after, and it is the only one where
approval can be backed by something executed.

The user runs this skill in both windows.

## The loop

1. **`impl_council_open`** — `agent: "claude"`, `task` in the user's words, `project_path`,
   and `plan_path` plus `plan_scope` when a plan exists.

   **Call this before you touch anything.** It records the current commit as the base, and
   every diff is measured from it. Open after editing and the base already contains your work.

   It also clears councils a dead session left behind, in `cleared`. Say what was cleared,
   then **tell the user to start Codex**. If the reply carries `resuming`, stop and ask
   whether to resume or start over — `fresh: true` discards.

2. **Do the work.** Normally, as you would without any of this.

3. **`impl_council_report`** — what you changed and why, file by file where it matters.

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
