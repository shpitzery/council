# Council — Design

**Date:** 2026-07-30
**Status:** Approved for implementation
**Revision:** 2 — core moved from shell scripts to an MCP server
**Author:** drafted with Claude, reviewed by Yuval Shpitzer

## Problem

Cross-checking one model's answer against another currently means copy-pasting a full
answer from one app into the other, in both directions, for every exchange. The value of
the second opinion is real; the shuttling cost is what makes it not worth doing.

The peers must keep their own project context. A stateless API call to a second model
does not solve this, because the point is a peer that already knows the task, the tests
that were run, and the bug that was found.

## Goal

A `council` MCP server plus a thin skill, installed in both Claude Code and Codex. The
user triggers it once per app. Both models answer the question independently, then
exchange critiques for a bounded number of rounds, then stop and report. The full exchange
is written to disk in a format readable by the user and validated by the server.

## Why MCP rather than skill-plus-scripts

Two reasons, both concrete:

1. **Entry format becomes enforceable.** As prose in a `SKILL.md`, "every DISAGREE must
   quote the peer" is a request that decays over rounds. As a tool schema with
   conditionally-required fields, a malformed submission is rejected before it is stored.
2. **Cross-process coordination moves into code we control.** Revision 1 needed
   seal-and-reveal files, write-once creation, and barrier checks — all of it working
   around two programs sharing a folder with no arbiter and no locking primitives. The
   server replaces that with a database transaction.

What MCP does **not** change: a tool only runs when a model calls it. The server cannot
wake an idle session. One trigger per window is still required, and multi-round automation
still depends on the stop hook. Phase 0 remains exactly as load-bearing as before.

## Non-goals (v1)

- Codex `/goal` — never created or modified by this skill. Read-only at most.
- Claude `/loop` — its minimum wake interval is 60s; council rounds have nothing to poll.
- Codex `multi_agent` / `spawn_agent` — spawns Codex subagents, same vendor, correlated
  blind spots. Explicitly forbidden (see Answer Rules).
- `ralph-loop` plugin — its technique is used, the plugin is not installed.
- Driving Codex headlessly via `codex exec` from inside Claude. Deferred; see Deferred Work.
- A third participant. The schema allows it; v1 does not implement it.
- Compressing entries (caveman or otherwise). Compression eats the qualifiers that carry
  the disagreement.
- Scheduling or unattended re-runs.

## Verified environment facts

Established by inspection on 2026-07-30. Recorded so they are not re-derived.

| Fact | Evidence |
|---|---|
| Codex CLI 0.146.0-alpha.3.1 is installed | binary at `~/.codex/plugins/.plugin-appserver/codex` |
| That path is not on `$PATH` | `command -v codex` returns nothing |
| Codex can register external MCP servers | `codex mcp add` / `list` / `get` / `remove` |
| Codex exposes a `stop` hook with `decision: "block"`, `reason`, `continue` | `stop.command.output` JSON Schema in the binary |
| Codex hook contract mirrors Claude Code's | schema comment: "Claude requires `reason` when `decision` is `block`" |
| Codex hook events | `pre-tool-use`, `permission-request`, `post-tool-use`, `pre-compact`, `post-compact`, `session-start`, `session-end`, `user-prompt-submit`, `subagent-start`, `subagent-stop`, `stop` |
| `hooks` feature is stable and enabled | `codex features list` |
| `goals` feature is stable and enabled | `codex features list`; table `thread_goals` in `~/.codex/goals_1.sqlite` |
| One goal per thread, max | `thread_id` is PRIMARY KEY in `thread_goals` |
| `multi_agent` stable+on, `multi_agent_v2` stable+off | `codex features list` |
| Codex subagent tools | `spawn_agent`, `send_input`, `wait`, `close_agent`, `list_agents` (v2) |
| Codex and its desktop app share session storage | `~/.codex/sessions/`, `~/.codex/session_index.jsonl` |
| `codex exec resume <id\|thread_name> <prompt>` exists | `codex exec resume --help` |
| `codex exec` supports `--output-schema`, `-o/--output-last-message`, `--json`, `-C/--cd` | `codex exec --help` |

### Unverified — must be tested during the build

1. Whether the Codex **desktop app** executes `stop` hooks. The feature flag is on and the
   CLI binary carries the contract, but app behaviour is not proven. **Phase 0 gates
   Phase 3 on this.**
2. Whether the Codex desktop app surfaces MCP servers registered via `codex mcp add`, or
   requires its own registration path. **Phase 1 verifies this before any protocol work.**
3. Each client's maximum tool-call duration. Drives the `council_await_peer` design; see
   Transport.
4. Whether `codex exec resume` can attach to a desktop-app session. Not needed for v1;
   relevant only to Deferred Work.

## Transport decision

MCP over **stdio** means each client spawns its own copy of the server. Claude and Codex
would run two separate processes. There is no single arbiter, and any claim that the
server "is the coordinator" is false under stdio.

Two options:

| | stdio, two processes | HTTP, one process |
|---|---|---|
| Coordination | SQLite transactions across processes | in-memory, single owner |
| Setup | register in both clients, nothing to run | a daemon to start, supervise, and restart |
| Failure | either process dies, the other continues | server dies, council dies |

**Chosen: stdio, with SQLite as the shared source of truth.**

SQLite gives real atomicity across processes — a transaction settles the barrier
correctly, which is precisely the guarantee revision 1 was hand-rolling with sealed files.
The cost of a supervised daemon is not justified for a two-participant, few-rounds
workload.

This means the server is stateless between calls. All state lives in SQLite. Any invariant
that matters must be enforced inside a transaction, never in process memory.

## Architecture

```
  Claude Code ──stdio──> council server (proc A) ──┐
                                                   ├──> ~/.council/council.db  (truth)
  Codex       ──stdio──> council server (proc B) ──┘
                                                   └──> ~/.council/<goal_id>/  (human copy)
```

SQLite is authoritative. The directory of JSON and markdown files is a rendering of it,
written for the user's benefit, never read back as state.

There is no turn order. Each round is a barrier: both sides submit their own entry for
round N, both wait until the peer's round-N entry exists, both read, both proceed.

Removing turn order removes an entire class of deadlock — neither side can be wrong about
whose move it is, because there are no moves in sequence.

## Data model

### Table `councils`

| Column | Notes |
|---|---|
| `goal_id` | `YYYY-MM-DD-<slug>`, primary key |
| `question` | as given by the user |
| `project_path` | the council folder no longer sits beside the code |
| `git_branch` | nullable |
| `round` | current round, starts at 1 |
| `max_rounds` | default 3 |
| `status` | `active` \| `converged` \| `capped` \| `error` \| `aborted` |
| `started_at`, `updated_at` | |

### Table `participants`

| Column | Notes |
|---|---|
| `goal_id`, `agent` | composite primary key |
| `session_id` | owning session, written on join; used by the stop hook |
| `joined_at` | |

### Table `entries`

| Column | Notes |
|---|---|
| `goal_id`, `agent`, `round` | composite primary key — makes double submission impossible at the storage layer |
| `position` | one sentence |
| `reasoning` | JSON array, ≤ 4 items |
| `evidence` | JSON array, ≤ 6 items |
| `verdict_on_peer` | `AGREE` \| `DISAGREE` \| `UNRESOLVED`, null on round 1 |
| `disagreement` | required when verdict is `DISAGREE` |
| `settling_test` | required when verdict is `UNRESOLVED` |
| `new_arguments` | boolean |
| `confidence` | `low` \| `med` \| `high` |
| `submitted_at` | |

The composite primary key on `entries` replaces revision 1's write-once file creation. A
second submission for the same `(goal_id, agent, round)` violates the key and is rejected.

### Disk rendering

```
~/.council/2026-07-30-failing-cache-tests/
  brief.md          # question, project, constraints, exit criteria
  r1-claude.json
  r1-codex.json
  r2-claude.json
  r2-codex.json
  verdict.md
```

**Round-1 files are written only after both participants have submitted.** This is what
replaces seal-and-reveal: there is no early file to read, because the server has not
written one yet. Rounds 2+ are written on submission, both sides having already committed.

## Tool surface

### `council_open`

```
question: string          (required on first call, ignored when joining)
agent: "claude" | "codex" (required)
session_id: string        (optional — recorded for the stop hook; see Open decisions)
project_path: string      (required)
git_branch: string        (optional)
max_rounds: integer       (optional, default 3)
goal_id: string           (optional — supply to join a specific council)
```

Idempotent. First caller creates the council; the second joins it. Returns `goal_id`,
current `round`, `final_round`, the brief, and the round instruction to follow.

### `council_submit`

Fields exactly as the `entries` table. Server-side validation, all inside one transaction:

- round must equal the council's current round for this agent
- duplicate `(goal_id, agent, round)` rejected
- `disagreement` required when `verdict_on_peer` is `DISAGREE`
- `settling_test` required when `verdict_on_peer` is `UNRESOLVED`
- `verdict_on_peer` must be null on round 1, non-null after
- length caps enforced

Returns whether the peer has already submitted this round.

### `council_await_peer`

```
goal_id, agent, round
```

Returns the peer's entry for that round once available, plus `final_round` and the next
round instruction.

**Does not block indefinitely.** Polls internally for up to 50 seconds, then returns
`{"arrived": false, "retry": true}`. The model calls again. This keeps every tool call
comfortably inside any client's timeout, since the per-client maximum is unverified
(Unverified #3). Total wait across retries is capped at 5 minutes, after which the council
moves to `status: "error"`.

For round 1 this call is the only path to the peer's answer, which is what makes
independence real: the content is not on the model's side of the wire until both have
submitted.

### `council_status`

Returns state, stop evaluation, and which rule fired. Read-only.

### `council_close`

Renders `verdict.md` and returns the session summary block. Callable by either side;
idempotent.

## Stop rules

Evaluated inside `council_submit` and reported by `council_status`. Server-authoritative.

| # | Condition | Resulting status |
|---|---|---|
| 1 | `round > max_rounds` | `capped` |
| 2 | Both latest entries have `verdict_on_peer == "AGREE"` | `converged` |
| 3 | Both latest entries have `new_arguments == false` | `converged` |
| 4 | Same agent reports `UNRESOLVED` in two consecutive rounds | `capped` |
| 5 | `status != "active"` | stop immediately |
| 6 | Cumulative await exceeds 5 minutes | `error` |

**Known limit, stated deliberately:** rules 2, 3 and 4 read what the models report about
themselves, and self-reported agreement is exactly the judgment this system exists to
distrust. Rule 1 is the only rule that does not depend on model honesty. `max_rounds` is
therefore the real guarantee; the rest are early exits that save time when they happen to
be right.

Moving to MCP does not improve this. A schema can enforce that a field is filled; it
cannot enforce that the answer in it is sincere.

### Final-round notice

When `round == max_rounds`, every tool response carries `final_round: true` and the round
instruction changes:

> This is the final round. Do not introduce new arguments. State your final position, and
> name explicitly what remains unresolved.

Without this, the debate is cut off mid-thought and the last entry is a fragment.

## Answer rules

Carried in both `SKILL.md` files. Marked by who enforces them.

| Rule | Enforced by |
|---|---|
| Every `DISAGREE` quotes the exact line it contests | **schema** — `disagreement` required |
| `UNRESOLVED` must name the check that would decide it | **schema** — `settling_test` required |
| Length caps: `position` one sentence, `reasoning` ≤ 4, `evidence` ≤ 6 | **schema** |
| Round 1 answered without seeing the peer | **server** — no read path exists yet |
| One entry per agent per round | **server** — primary key |
| Evidence must be `file:line`, command output, test result, or a document quote. "I think", "it's cleaner", "best practice" are not evidence | prose |
| No assertion-only agreement. Changing position requires citing something; "good point, you're right" does not close a disagreement | prose |
| **No subagents.** Claude must not use the Agent tool. Codex must not use `spawn_agent` | prose |

The subagent prohibition matters beyond cost: a subagent lacks the session context that is
the entire reason this system exists, and its output is returned wearing the parent's name.
The user would believe they received the peer model's opinion when they received a blank
helper's.

The prose rules are judgments, not shapes. No schema can check whether a citation is
honest or a reason is real. They stay guidance, and the record on disk is what lets the
user audit them.

## Session output

On close, each side prints to its own window:

```
COUNCIL <goal_id> — <status> after <n> rounds

Peer's position:  ...
My position:      ...
Agreed:           ...
Unresolved:       ...
Recommendation:   ...
Full record:      ~/.council/<goal_id>/
```

`verdict.md` contains the same block plus the round-by-round record.

The two windows may print summaries that disagree with each other. This is expected and
informative: if the participants cannot agree on what they agreed, the `converged` status
was wrong and the user should read the record.

## Failure handling

| Failure | Behaviour |
|---|---|
| Peer never joins | `council_await_peer` retries to a 5-minute cap, then `status: "error"`; whatever exists is rendered |
| Duplicate submission | Rejected by primary key with an explicit message; no silent overwrite |
| Malformed submission | Rejected by schema validation before storage; the model is told which field failed |
| Database locked or corrupt | Fail loudly, name the file, do not guess |
| One server process dies | The other continues; SQLite is the truth and survives |
| Stop hook misfires and blocks exit | Set `status` to `aborted` (or delete the row); the hook releases on its next check. The hook also enforces `max_rounds` independently |
| Council folder or database unwritable | Fail at `council_open`, before either model has spent tokens |
| Codex app does not surface the MCP server | Discovered in Phase 1, before protocol work |

The stop hook must be session-scoped, matching `ralph-loop`'s pattern: it compares its own
session id against the `participants.session_id` for its agent and exits without blocking
when they differ. Otherwise it hijacks unrelated sessions.

**The kill switch** is `status`. Setting it to `aborted` — by tool call, or by one `UPDATE`
against the database — releases both sides on their next call.

## Components

| Component | Notes |
|---|---|
| `council` MCP server | Python, stdio transport, SQLite storage. Five tools above. |
| `stop-hook.sh` | One file, works unchanged in both apps, since Codex implements Claude Code's hook contract. Reads status and round from SQLite. Enforces `max_rounds` itself. |
| `~/.claude/skills/council/SKILL.md` | Trigger, answer rules, round instructions, no-subagents rule |
| `~/.codex/skills/council/SKILL.md` | Same, differing only in the subagent wording (Agent tool vs `spawn_agent`) |

Slash commands come from skills, not from tools. The skills stay thin: they carry the
trigger and the judgment rules, and nothing that a schema already enforces.

## Build phases

Each phase leaves a working artifact.

| Phase | Work | Verified by |
|---|---|---|
| **0** | Trivial `stop` hook installed in the Codex desktop app | Hook fires and blocks exit → Phase 4 is viable. It does not → Phase 4 is dropped and manual mode ships. |
| **1** | Minimal MCP server, one `council_ping` tool, registered in both clients | Both apps list and call the tool. Settles Unverified #2 and measures Unverified #3 before any real work depends on it. |
| **2** | Schema, SQLite, all five tools, stop rules | Two scripted clients drive a full council with no models involved: barrier holds, round-1 content is not readable early, duplicate submission is rejected, every stop rule fires |
| **3** | Both `SKILL.md` files | **Working manual version.** `/council` typed once per round per window produces a complete record and verdict. |
| **4** | `stop-hook.sh` in both apps | One trigger per window drives all rounds to a stop; setting `status` to `aborted` mid-run releases both within one poll |
| **5** | `verdict.md` rendering, summary block, polish | Verdict readable without opening the JSON |

Phase 0 runs first because its result determines whether Phase 4 exists. Phase 1 runs
before Phase 2 because a Codex app that cannot see the server invalidates the whole shape,
and that is cheap to find out. Phase 3 is a usable product on its own.

## Deferred work

- **Headless driving via `codex exec`.** Would collapse two triggers into one: Claude calls
  `codex exec resume` per round from inside its own turn. Requires the unverified session
  attachment behaviour, and reintroduces a referee-bias problem — Claude both competes in
  the debate and runs it. Revisit after v1 is in use.
- **HTTP transport.** If two stdio processes prove awkward, a single supervised server
  removes the cross-process question entirely. The tool surface does not change.
- **A third participant.** The data model already allows it; the stop rules assume two and
  would need rewriting.
- **Unattended re-runs** (re-run a council when tests change). Genuine scheduling work, and
  `/loop` is the right tool. Separate feature.

## Open decisions

### How the stop hook identifies its own council — unresolved

The hook receives a session id from its host. `participants.session_id` is meant to match
it, so the hook knows whether this session owns the active council. But it is not
established that a model can obtain its own session id in order to pass it to
`council_open`.

Candidate approaches, to be settled in Phase 1 once the clients' server environment is
observable:

1. The client passes a session identifier to the MCP server as an environment variable.
   Cleanest if it exists; unverified for both clients.
2. Scope by `project_path` plus the participant's agent name, accepting that two
   simultaneous councils in one project on one side are unsupported. Adequate for v1.
3. The hook writes its own session id on first fire, and the server binds it then. Late,
   but self-correcting.

Approach 2 is the fallback and is sufficient to ship Phase 4; it only forbids a case that
does not arise in normal use. This is a Phase 1 finding, not a blocker.

### Settled defaults

Root `~/.council/`, `max_rounds` 3, await poll 50s per call, 5-minute total cap,
Python + stdio + SQLite.
