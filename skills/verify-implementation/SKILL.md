---
name: verify-implementation
description: Verify that a code change is complete and correct before it is treated as done. Use when asked to check an implementation, review a diff against a plan, confirm work was actually finished, or validate that changes do what a report or plan claims. Checks completeness against the plan first, then correctness of the code.
---

# Verify Implementation

## Purpose

Answer two questions about a change that has already been written, in this order:

1. **Is it complete?** Does it do everything that was asked, in the scope named?
2. **Is it correct?** Does the code work, and does it break nothing?

They come apart. A change can be flawless and half-finished, or complete and broken. A
review that blurs them will approve one while missing the other.

This is not a style review. Find only what affects correctness, completeness, production
safety, or maintainability.

## Inputs

- **The diff.** `git diff <base_ref>` — the base commit is given to you. Read the whole diff
  before forming any view.
- **The report**, if the author wrote one: what they say they changed.
- **The plan and scope**, if a plan is attached: the yardstick for complete.

## Pass 1 — Complete?

Skip this pass entirely when no plan is attached; there is nothing to be incomplete against.

Read the plan, and read the scope you were given — *"W1 and W2A"*, *"sections 1–3"*. **Only
the named scope is in play.** A plan with seven gates is not meant to be finished in one
sitting, and reporting the other six as missing buries the real gaps.

For each item in scope, decide: **done**, **partial**, or **missing** — each cited against
the diff. An item is not done because the plan says it will be; it is done because the diff
does it.

Count the **partial** and **missing** items. That number is the gap count, and it blocks
approval at every round.

**The plan itself is not on trial.** It already survived its own review. Check the code
against it, do not re-argue it. If a step genuinely cannot work as written — it contradicts
the code, or describes something that does not exist — say so separately and stop; that is
the user's call, not yours to fix and not the author's to quietly rewrite.

## Pass 2 — Correct?

Read the diff against the code it touches: the call sites, the surrounding conventions, the
tests. Do not rely on how codebases like this usually work.

Look for:

- logic that does not do what the change intends
- edge cases and failure paths the change opens
- contracts broken for existing callers
- concurrency, ordering, and lifetime problems
- data loss, migration, and compatibility risks
- tests that do not actually cover the new behaviour

**Verify each finding before you report it.** Open the file, read the surrounding code, and
confirm it. A finding you could not confirm is not a finding — say what you checked and why
it is unresolved instead.

### Not findings

- issues that already existed on lines this change did not touch
- pedantic nitpicks a senior engineer would not raise
- anything a linter, type checker or compiler catches on its own
- general code-quality wishes not required by the repo's own instructions
- changes that are clearly intentional and part of the broader work

## Does the report match the diff?

Answer separately, because it is the failure mode unique to verifying someone else's work:

- something the report claims that the diff does not do
- something the diff changes that the report never mentions

Either one is blocking on its own. Quote the specific claim or the specific change.

## Verification

Say what you actually checked and how it came out. This is the part that makes an approval
worth something.

**Running the tests is one way, not the only way.** Reading a function's three call sites and
showing that none can reach it after shutdown is verification. Tracing an error path to where
it is handled is verification. Pick the check that would actually catch the failure you are
worried about, and run *that*.

What does not count: *"looks correct"*, *"seems fine"*, *"the change is straightforward"*.
If you cannot say what you checked, you have not verified anything.

## Severity

- `Blocker` — cannot ship: breaks production, loses data, or does not work
- `High` — likely bug, broken contract, unsafe path, or a serious gap in tests
- `Medium` — real edge case, unclear ownership, or maintainability risk
- `Low` — small improvement; raise only if it affects execution

Avoid `Low`. Never downgrade a real Blocker to move things along — the whole value of this
is a verdict that means what it says.

## Output Format

```markdown
**Completeness**
- [scope item] done / partial / missing — cited against the diff. Omit when no plan.

**Findings**
- [Severity] Issue: why it matters, at file:line. Fix: the change needed.

**Report vs diff**
Matches / Does not match — with the specific claim or change if it does not.

**Verified by**
What you checked and how it came out.

**Verdict**
Approve / Changes needed, with one sentence.
```

`Approve` only when nothing in scope is missing, no Blocker or High stands, the report
matches the diff, and you can say what you checked. Otherwise `Changes needed`.

## No subagents

Do all of this yourself. A subagent lacks the session context that is the reason you were
asked, and its verdict would be returned under your name.
