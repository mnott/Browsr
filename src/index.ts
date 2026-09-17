#!/usr/bin/env node
/**
 * browsr-mcp — stdio MCP server for the browsr bridge.
 *
 * Browser control for agents, provider independent: drives the user's real
 * running Chrome (tabs + DOM) through the browsr extension's native messaging
 * host, over ws://127.0.0.1:8757. Any MCP client works — nothing here is
 * coupled to any one provider.
 *
 *   provider → MCP (this server) → WebSocket → native host → extension → Chrome
 *
 * If Chrome is not running (or the extension is not loaded), every tool
 * returns a clear "start Chrome" error; the server itself stays alive and
 * reconnects lazily per call.
 */

import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BridgeClient, globalWebSocketFactory } from "./bridge-client.js";
import { INSTRUCTIONS } from "./instructions.js";
import { registerBrowserTools } from "./tools.js";

// Keep the advertised version in step with the package rather than
// hand-maintaining it here.
const PKG_VERSION: string = createRequire(import.meta.url)("../package.json").version;

async function main(): Promise<void> {
  if (globalThis.WebSocket === undefined) {
    // Node < 22 has no global WebSocket client; say so instead of crashing
    // with an opaque TypeError when the first tool call connects.
    process.stderr.write(
      "browsr: this node runtime has no global WebSocket — browsr needs node >= 22\n"
    );
    process.exit(1);
  }

  const server = new McpServer(
    { name: "browsr", version: PKG_VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
  );

  const bridge = new BridgeClient(undefined, globalWebSocketFactory);
  registerBrowserTools(server, bridge);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  process.stderr.write(`browsr fatal error: ${String(e)}\n`);
  process.exit(1);
});
