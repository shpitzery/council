# council
An MCP server that runs structured, bounded critique rounds between Claude Code and Codex, each keeping its own session context.

Two models, both already working on your problem, both with their own context. Getting one to check the other means copy-pasting a wall of text in each direction, every round — so mostly you don't bother.

council turns that into one command per window. There are three modes over one server and one database.

## `/council` — the debate

Both models answer the same question independently, neither seeing the other first. Then they trade critiques, each disagreement required to quote the line it contests and cite something real. When the rounds end one drafts the answer and the other reviews it.

It stops after a fixed number of rounds — because two models agreeing is the least trustworthy signal in the system, and a round cap is the only stopping rule that doesn't depend on them being honest.

## `/plan-council` — the critique/resolve loop

Automates the loop you otherwise run by hand: Codex critiques your implementation plan, you paste the critique to Claude, Claude applies it, repeat until Codex says the plan is ready to build.

Claude authors, Codex critiques. Codex runs its `critique-plan` skill; Claude runs `plan-critique-resolver`, which edits the plan file in place. The council is only the wire and the loop — it passes text, counts rounds, records the trail, and stops. Neither skill is restated here.

**It stops when the critic says the plan is implementation-ready.** That is a verdict from the side whose job is to find fault, which makes it the strongest stopping rule in the project — the debate mode can only stop on two models agreeing about themselves. The critic cannot declare a plan ready while reporting Blocker or High findings; the server rejects it.

Ten rounds at most. From round 3 only Blocker and High hold a plan back, because a thorough critic finds new Medium issues forever — every revision creates new surface. If the resolver hits a decision that is genuinely the user's, the council parks and hands it back rather than letting the author guess to keep the loop moving.

Both models see how long the plan is and how much each round added. Nothing in the loop ever removes anything, so without that number in front of them a plan quietly grows into a specification nobody can implement from.

## `/impl-council` — verify what was built

The other two run before code exists. This one runs after: Claude writes the change, Codex verifies it, Claude applies what holds, until Codex approves.

Codex reads the real diff — the server records a base commit and measures the change itself, so the side that wrote the code is not the side reporting how much of it there is. Attach a plan and the slice of it in scope, and completeness is checked against that too.

It also runs on work already written: leave the changes uncommitted and the default base picks them up, or name an earlier `base_ref` for work already committed. Get that wrong and the base contains the change, so the diff is empty — the council says so rather than letting the critic approve nothing.

**Its approval is the only verdict in this project that can be backed by execution.** A plan can only be read; code can be run. So an approval is refused unless the review says what was actually checked — though running the tests is not the only way to check, and reading the call sites to show nothing breaks counts. What is refused is "looks correct".

Also refused: any Blocker or High finding still standing, any item of the named scope unimplemented, and a report that does not match the diff — the failure unique to this mode, where an author claims work it did not do or quietly changes something it never mentioned.

Medium findings stop blocking from round 3, as in the plan council. Unimplemented scope never does: complete is the point, and it is a fact rather than a judgement about quality. A plan attached here already survived its own council, so the critic checks the work against it and never reopens it — a step that cannot work as written parks for you instead.

## All three modes

**One council at a time, across all three.** Any mode blocks the other two. `council_abandon` is the release for either — closing renders a record, it does not release anything.

Starting a plan or implementation council clears unfinished work a dead session left behind and reports what it cleared. Two things it will never clear: a council on the same plan file, which is you resuming, and anything touched in the last fifteen minutes, which may be a peer mid-turn. Picking up existing work is your call — the author reports what it found and asks before resuming or starting over.

## Install

```bash
npm install
npm run install-skills   # copies all seven SKILL.md files into ~/.claude and ~/.codex
npm test
```

Register `src/server.js` as an MCP server in both clients. State lives in `~/.council/`: `council.db` is the truth, and the folder per council is a rendering of it for you to read.
