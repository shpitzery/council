#!/usr/bin/env node
// council — MCP server.
//
// Phase 1 skeleton. One diagnostic tool, `council_ping`, which answers the three
// questions Phase 1 exists to settle:
//   1. Does each client — in particular the Codex desktop app — surface this server?
//   2. How long may a single tool call run before the client gives up?
//   3. What, if anything, identifies the calling session to the server process?
//
// stdout carries the MCP protocol. Nothing may be written to it but protocol frames.
// All diagnostics go to stderr.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const log = (...args) => console.error("[council]", ...args);

// Environment keys worth inspecting when hunting for a session identifier.
const INTERESTING = /SESSION|CONVERSAT|THREAD|CLAUDE|CODEX|MCP|AGENT|WORKSPACE|PROJECT/i;
// Anything matching this has its value masked — these logs get pasted around.
const SECRET = /TOKEN|KEY|SECRET|PASSWORD|PAT|AUTH|CREDENTIAL/i;

function environmentReport() {
  const out = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!INTERESTING.test(key)) continue;
    out[key] = SECRET.test(key) ? `<masked, ${value.length} chars>` : value;
  }
  return out;
}

const server = new McpServer(
  { name: "council", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.registerTool(
  "council_ping",
  {
    title: "Council ping",
    description:
      "Diagnostic for the council server. Returns which client is connected, what the " +
      "server can see of the session, and how long the call actually took. Pass " +
      "delay_seconds to measure the client's maximum tool-call duration.",
    inputSchema: {
      delay_seconds: z
        .number()
        .min(0)
        .max(300)
        .optional()
        .describe("Seconds to sleep before replying. Use 10, 30, 60, 90 to find the client's limit."),
    },
  },
  async ({ delay_seconds = 0 }) => {
    const started = Date.now();
    log(`council_ping called, delay=${delay_seconds}s`);

    if (delay_seconds > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay_seconds * 1000));
    }

    const elapsed = (Date.now() - started) / 1000;

    // Who connected. Reported by the client during initialize.
    let client = null;
    try {
      client = server.server.getClientVersion() ?? null;
    } catch {
      client = null;
    }

    const report = {
      ok: true,
      marker: "COUNCIL-PING-OK",
      client,
      requested_delay_seconds: delay_seconds,
      elapsed_seconds: Number(elapsed.toFixed(2)),
      server_pid: process.pid,
      server_cwd: process.cwd(),
      node_version: process.version,
      environment: environmentReport(),
      timestamp: new Date().toISOString(),
    };

    log(`council_ping returning after ${elapsed}s`);
    return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
log(`ready, pid ${process.pid}, cwd ${process.cwd()}`);
