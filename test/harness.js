// Two simulated clients drive a whole council. No models involved.
//
// Each client gets its own server process, exactly as Claude and Codex do, so this
// exercises the real cross-process path rather than a single in-memory shortcut.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, rmSync, readdirSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, "..", "src", "server.js");

export function makeRoot(name) {
  const root = join("/tmp", `council-test-${name}-${process.pid}`);
  rmSync(root, { recursive: true, force: true });
  return root;
}

export async function connect(agent, root) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: {
      ...process.env,
      COUNCIL_ROOT: root,
      COUNCIL_POLL_BUDGET_MS: process.env.COUNCIL_POLL_BUDGET_MS ?? "2000",
      COUNCIL_POLL_INTERVAL_MS: "100",
      COUNCIL_TOTAL_WAIT_MS: process.env.COUNCIL_TOTAL_WAIT_MS ?? "300000",
      COUNCIL_PLAN_JOIN_WAIT_MS: process.env.COUNCIL_PLAN_JOIN_WAIT_MS ?? "300000",
      COUNCIL_PLAN_STEP_WAIT_MS: process.env.COUNCIL_PLAN_STEP_WAIT_MS ?? "1800000",
      COUNCIL_STALE_AFTER_MS: process.env.COUNCIL_STALE_AFTER_MS ?? "900000",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: `council-harness-${agent}`, version: "0.1.0" });
  await client.connect(transport);
  return client;
}

/** Call a tool and parse the JSON payload back out. */
export async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const payload = JSON.parse(result.content[0].text);
  return { payload, isError: Boolean(result.isError) };
}

export const entry = (over = {}) => ({
  position: "Fix the cache key derivation.",
  reasoning: ["The key omits the tenant id, so two tenants collide."],
  evidence: ["src/cache/keys.py:41 — key built from (endpoint, params)"],
  new_arguments: true,
  confidence: "med",
  ...over,
});

export const filesIn = (dir) => (existsSync(dir) ? readdirSync(dir).sort() : []);
