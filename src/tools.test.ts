/**
 * Tests for the browsr MCP tools: every tool must map to the right wire
 * command with the right params, the not-connected case must surface the
 * "start Chrome" error text as a tool error end to end through a real MCP
 * client, and bridge errors must surface as tool errors. No real Chrome, no
 * real socket — the bridge is a mock.
 */

import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerBrowserTools, BROWSER_TOOLS, runBrowserTool } from "./tools.js";
import { BridgeClient, NOT_CONNECTED_MESSAGE, type WebSocketLike } from "./bridge-client.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** Immediately-failing socket: connects to nothing, errors right away. */
export function failingSocketFactory() {
  return () => {
    const ws: WebSocketLike = {
      readyState: 0,
      onopen: null,
      onclose: null,
      onerror: null,
      onmessage: null,
      send: () => {},
      close: () => {},
    };
    setTimeout(() => ws.onerror?.(), 0);
    return ws;
  };
}

async function connectedPair(bridge: { send: (c: string, p?: Record<string, unknown>) => Promise<unknown> }) {
  const server = new McpServer({ name: "browsr-test", version: "0.0.0" });
  registerBrowserTools(server, bridge);
  const client = new Client({ name: "browsr-test-client", version: "0.0.0" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

// ---------------------------------------------------------------------------
// Tool → wire mapping
// ---------------------------------------------------------------------------

describe("browser MCP tool → wire command mapping", () => {
  it("exposes exactly the 15 tools", () => {
    expect(BROWSER_TOOLS.map((t) => t.name)).toEqual([
      "browsr_version",
      "tabs_list",
      "tab_open",
      "tab_select",
      "tab_close",
      "dom_snapshot",
      "dom_click",
      "dom_type",
      "dom_select_option",
      "dom_set_checked",
      "dom_press",
      "page_text",
      "eval_js",
      "tab_screenshot",
      "console_logs",
    ]);
  });

  const cases: Array<[string, Record<string, unknown>, string, Record<string, unknown>]> = [
    ["browsr_version", {}, "version", {}],
    ["tabs_list", {}, "list_tabs", {}],
    ["tab_open", { url: "https://example.org", active: false }, "open_tab", { url: "https://example.org", active: false }],
    ["tab_open", { url: "https://example.org" }, "open_tab", { url: "https://example.org" }],
    ["tab_select", { tab: 7 }, "select_tab", { tabId: 7 }],
    ["tab_close", { tab: 7 }, "close_tab", { tabId: 7 }],
    ["dom_snapshot", { tab: 3 }, "snapshot", { tabId: 3 }],
    ["dom_click", { tab: 3, ref: "s5" }, "click", { tabId: 3, ref: "s5" }],
    ["dom_type", { tab: 3, ref: "s5", text: "hello" }, "type", { tabId: 3, ref: "s5", text: "hello" }],
    ["dom_type", { tab: 3, ref: "s5", text: "hello", mode: "replace" }, "type", { tabId: 3, ref: "s5", text: "hello", mode: "replace" }],
    ["dom_select_option", { tab: 3, ref: "s5", value: "2" }, "select_option", { tabId: 3, ref: "s5", value: "2" }],
    ["dom_select_option", { tab: 3, ref: "s5", label: "Option 2" }, "select_option", { tabId: 3, ref: "s5", label: "Option 2" }],
    ["dom_select_option", { tab: 3, ref: "s5", index: 1 }, "select_option", { tabId: 3, ref: "s5", index: 1 }],
    ["dom_set_checked", { tab: 3, ref: "s6", checked: true }, "set_checked", { tabId: 3, ref: "s6", checked: true }],
    ["dom_press", { tab: 3, key: "enter", ref: "s2" }, "press", { tabId: 3, key: "enter", ref: "s2" }],
    ["dom_press", { tab: 3, key: "a" }, "press", { tabId: 3, key: "a" }],
    ["page_text", { tab: 3 }, "eval", { tabId: 3, code: "document.body.innerText" }],
    ["eval_js", { tab: 3, code: "1 + 1" }, "eval", { tabId: 3, code: "1 + 1" }],
    ["tab_screenshot", { tab: 3 }, "screenshot", { tabId: 3 }],
    ["console_logs", { tab: 3 }, "console_logs", { tabId: 3 }],
  ];

  it.each(cases)("%s maps to %s with the right params", async (tool, args, command, params) => {
    const send = vi.fn().mockResolvedValue({});
    const result = await runBrowserTool(
      BROWSER_TOOLS.find((t) => t.name === tool)!,
      args,
      { send }
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(command, params);
    expect(result.isError).toBeFalsy();
  });

  it("every tool whose schema takes a tab sends tabId on the wire (no dropped params)", async () => {
    // The background command handlers read p.tabId; a toParams that forgets it
    // sends NaN into chrome.tabs/chrome.scripting and dies with an opaque
    // "expected integer" error in real Chrome — exactly what the per-tool cases
    // above once missed for eval_js and page_text. This sweep closes the gap
    // for every current and future tab-addressed tool.
    const withTabs = BROWSER_TOOLS.filter((t) => "tab" in t.shape);
    expect(withTabs.map((t) => t.name)).toEqual([
      "tab_select",
      "tab_close",
      "dom_snapshot",
      "dom_click",
      "dom_type",
      "dom_select_option",
      "dom_set_checked",
      "dom_press",
      "page_text",
      "eval_js",
      "tab_screenshot",
      "console_logs",
    ]);
    for (const def of withTabs) {
      const args: Record<string, unknown> = { tab: 42 };
      if ("ref" in def.shape) args.ref = "s1";
      if ("text" in def.shape) args.text = "x";
      if ("code" in def.shape) args.code = "1";
      if ("checked" in def.shape) args.checked = true;
      if ("key" in def.shape) args.key = "enter";
      const send = vi.fn().mockResolvedValue({});
      await runBrowserTool(def, args, { send });
      expect(send.mock.calls[0][1], def.name).toMatchObject({ tabId: 42 });
    }
  });

  it("tabs_list formats the tab list", async () => {
    const def = BROWSER_TOOLS.find((t) => t.name === "tabs_list")!;
    const result = await runBrowserTool(def, {}, {
      send: async () => [
        { id: 1, title: "Example", url: "https://example.org", active: true },
        { id: 2, title: "Other", url: "https://other.org", active: false },
      ],
    });
    expect(result.content[0].text).toContain("1 * Example");
    expect(result.content[0].text).toContain("https://other.org");
  });

  it("dom_snapshot returns the YAML verbatim", async () => {
    const def = BROWSER_TOOLS.find((t) => t.name === "dom_snapshot")!;
    const result = await runBrowserTool(def, { tab: 1 }, {
      send: async () => ({ yaml: '- document "X":\n  - button "Go" [ref=s1]' }),
    });
    expect(result.content[0].text).toBe('- document "X":\n  - button "Go" [ref=s1]');
  });
});

// ---------------------------------------------------------------------------
// Not connected
// ---------------------------------------------------------------------------

describe("browser MCP when the bridge is not connected", () => {
  it("returns the start-Chrome error as a tool error, end to end through MCP", async () => {
    const client = await connectedPair(new BridgeClient("ws://127.0.0.1:1", failingSocketFactory()));
    const res = (await client.callTool({ name: "tabs_list", arguments: {} })) as {
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
    };
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe(NOT_CONNECTED_MESSAGE);
  });

  it("bridge errors surface as tool errors with the bridge message", async () => {
    const def = BROWSER_TOOLS.find((t) => t.name === "dom_click")!;
    const result = await runBrowserTool(def, { tab: 1, ref: "s99" }, {
      send: async () => {
        throw new Error("unknown ref s99 — take a new snapshot");
      },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("unknown ref s99");
  });
});
