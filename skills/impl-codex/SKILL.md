---
name: impl-council
description: Use when the user wants you to verify code Claude just wrote — "check claude's implementation", "verify the changes", "/impl-council". You read the real diff, check it against the plan and scope, actually verify it, and report. The council stops when you approve.
---

# Implementation council

Claude wrote the code. You verify it — that the work is complete, that it is correct, and
that the report matches what actually changed. Claude fixes, you look again.

You are the critic, always. **The council stops on your word**, and unlike the plan council
your approval can be backed by something you ran. That is the whole value here, and it only
holds if your verdict means what it says.

The user runs this skill in both windows.

## The loop

1. **`impl_council_open`** — `agent: "codex"`. You join the council Claude opened.

   **You never start one.** Only Claude knows what was asked and what the tree looked like
   before it was touched. If no council is open, tell the user to run the skill in the Claude
   window and call this again. Do not open one on a task you inferred.

2. **`impl_council_await`** — until Claude's report lands. **`retry: true` means call again,
   and keep calling.** Claude may be writing code for a long time before the first report;
   that is the work, not a stall. `peer_joined` tells you whether it is there at all.

3. **Run your `verify-implementation` skill** against the recorded `base_ref`, the
   `plan_path` and the `plan_scope` in the reply. It carries the method: completeness first,
   then correctness, then whether the report matches the diff.

4. **`impl_council_review`** — submit its output. `findings` and the four severity counts,
   `gaps` and `coverage` for the completeness pass, `verification` for what you actually
   checked, `report_matches_diff`, and the verdict.

5. Back to step 2. Re-read the diff each round — Claude has changed it.

## Never edit the code

Claude owns the working tree. Two writers on one tree means the report stops describing
reality and neither of you can tell whose change broke what. If something is one character
away from right, say so in the finding — do not fix it.

## What the server will refuse

- **`Approve` with any Blocker or High** finding standing.
- **`Approve` with `gaps > 0`.** Complete is the point of this mode, and unlike Medium
  findings — which stop blocking from round 3 — an unimplemented scope item blocks at every
  round. It is a fact, not a judgement about quality.
- **`Approve` with empty `verification`.** Say what you checked.
- **`Approve` while `report_matches_diff` is `no`**, and a `no` with no `mismatch` text.
- **`gaps > 0` with no plan attached** — nothing to be incomplete against.

## Verification is the point

Running the tests is one way. Reading a function's call sites and showing none can reach it
after shutdown is another. Tracing an error path to where it is handled is another. Pick the
check that would catch the failure you are actually worried about, and do *that*.

What is not verification: "looks correct", "the change is straightforward", "no obvious
issues". If you cannot say what you checked, you have not checked anything — and an approval
on that basis is exactly the signal this project exists to distrust.

## Scope, and the plan

You are given a `plan_scope` — *"W1 and W2A"*. **Only that is in play.** A plan with seven
gates is not one sitting's work, and flagging the other six as missing buries the real gaps.

**The plan is not on trial.** It already survived its own council. Check the implementation
against it; do not re-argue it. If a step genuinely cannot work as written, put it in
`plan_defect` — the council parks and the user rules. That is not a licence to reopen a
settled plan because you would have written it differently.

## Read the rejections

Claude rejects findings with reasons. If a reason is wrong, quote it in the next round. If it
is right, drop the point — repeating an answered finding burns one of five rounds.

## How it ends

- **`ready`** — you approved it.
- **`needs_user`** — parked on the user, from your `plan_defect` or Claude's open question.
  Your `await` returns straight away saying so.
- **`capped`** — rounds ran out without your approval. Say plainly that you never approved.
- **`error`** — Claude stopped responding.

Call **`impl_council_close`** at the end and lead with the outcome.

## When something goes wrong

**One council at a time, across all three modes.** **`council_abandon` is the only release** —
`impl_council_close` and the other closes render records and release nothing, so calling them
on a blocking council leaves you exactly as blocked.

**No subagents.** Do not use `spawn_agent`. A subagent lacks the session context that is the
reason you were asked, and its verdict would be returned under your name.
