#!/bin/bash
# Phase 0 probe — throwaway diagnostic, delete once the question is answered.
#
# Answers two things about the Codex desktop app:
#   1. Does it run Stop hooks at all?
#   2. Does {"decision":"block"} actually continue the turn?
#
# Also records the hook's stdin payload, which is how we learn what session
# identifier the host provides. That settles an open decision in the design.
#
# Safety: blocking is off by default, and even when on it releases after two
# attempts and disarms itself. This cannot trap a session.

set -uo pipefail

LOG=/tmp/codex-stop-probe.log
COUNT_FILE=/tmp/codex-stop-probe.count
MODE_FILE=/tmp/codex-stop-probe.mode   # "observe" (default) or "block"

INPUT=$(cat 2>/dev/null || true)

{
  printf '=== %s fired ===\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')"
  printf 'stdin: %s\n' "${INPUT:-<empty>}"
} >> "$LOG"

MODE=$(cat "$MODE_FILE" 2>/dev/null || echo observe)

if [[ "$MODE" != "block" ]]; then
  printf 'mode=observe, allowing exit\n\n' >> "$LOG"
  exit 0
fi

COUNT=$(cat "$COUNT_FILE" 2>/dev/null || echo 0)
[[ "$COUNT" =~ ^[0-9]+$ ]] || COUNT=0

if (( COUNT >= 2 )); then
  printf 'block limit reached, disarming and allowing exit\n\n' >> "$LOG"
  echo observe > "$MODE_FILE"
  echo 0 > "$COUNT_FILE"
  exit 0
fi

echo $((COUNT + 1)) > "$COUNT_FILE"
printf 'blocking, attempt %s\n\n' "$((COUNT + 1))" >> "$LOG"

printf '{"decision":"block","reason":"Phase 0 probe: reply with the single word PROBE-OK and nothing else."}\n'
exit 0
