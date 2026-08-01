// Smoke test: start the server over stdio, list tools, call council_ping.
// Proves the server speaks MCP and keeps stdout clean before it is registered anywhere.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, "..", "src", "server.js");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  stderr: "pipe",
});

const client = new Client({ name: "council-smoke-test", version: "0.1.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));
assert.ok(
  tools.some((t) => t.name === "council_ping"),
  "council_ping should be listed",
);

const started = Date.now();
const result = await client.callTool({
  name: "council_ping",
  arguments: { delay_seconds: 2 },
});
const roundTrip = (Date.now() - started) / 1000;

const report = JSON.parse(result.content[0].text);
assert.equal(report.marker, "COUNCIL-PING-OK");
assert.ok(report.elapsed_seconds >= 2, "delay should be honoured");

console.log("client seen by server:", JSON.stringify(report.client));
console.log("round trip:", roundTrip.toFixed(2), "s");
console.log("session-ish env keys:", Object.keys(report.environment).join(", ") || "(none)");
console.log("\nPASS");

await client.close();
