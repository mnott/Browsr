/**
 * Tests for BridgeClient's request id correlation: monotonic ids, out-of-order
 * replies matched to their requests, not-ok replies rejected with the bridge
 * error message. The socket is a scriptable fake — no real bridge.
 */

import { describe, it, expect } from "vitest";
import { BridgeClient, type WebSocketLike } from "./bridge-client.js";

/**
 * Scriptable socket: opens on the next tick, records everything sent, and
 * lets the test deliver replies by id.
 */
function fakeSocketFactory() {
  const sockets: Array<WebSocketLike & { sent: string[]; reply: (s: string) => void }> = [];
  const factory = () => {
    const ws = {
      readyState: 0,
      sent: [] as string[],
      onopen: null as (() => void) | null,
      onclose: null as (() => void) | null,
      onerror: null as (() => void) | null,
      onmessage: null as ((ev: { data: string }) => void) | null,
      send: (data: string) => {
        ws.sent.push(data);
      },
      close: () => {
        ws.readyState = 3;
        ws.onclose?.();
      },
      reply: (s: string) => ws.onmessage?.({ data: s }),
    };
    sockets.push(ws);
    setTimeout(() => {
      ws.readyState = 1;
      ws.onopen?.();
    }, 0);
    return ws;
  };
  return { factory, sockets };
}

describe("BridgeClient request id correlation", () => {
  it("correlates replies by id, even out of order", async () => {
    const { factory, sockets } = fakeSocketFactory();
    const client = new BridgeClient("ws://127.0.0.1:8757", factory);
    const p1 = client.send("list_tabs");
    const p2 = client.send("screenshot", { tabId: 1 });
    await new Promise((r) => setTimeout(r, 10));
    const sock = sockets[0];
    expect(sock.sent).toHaveLength(2);
    const f1 = JSON.parse(sock.sent[0]);
    const f2 = JSON.parse(sock.sent[1]);
    expect(f1.command).toBe("list_tabs");
    expect(f2.command).toBe("screenshot");
    expect(f2.id).toBe(f1.id + 1); // monotonic ids
    // reply out of order
    sock.reply(JSON.stringify({ id: f2.id, ok: true, result: "png-first" }));
    sock.reply(JSON.stringify({ id: f1.id, ok: true, result: ["tab"] }));
    expect(await p2).toBe("png-first");
    expect(await p1).toEqual(["tab"]);
  });

  it("rejects a not-ok reply with the bridge error", async () => {
    const { factory, sockets } = fakeSocketFactory();
    const client = new BridgeClient("ws://127.0.0.1:8757", factory);
    const p = client.send("click", { tabId: 1, ref: "s1" });
    await new Promise((r) => setTimeout(r, 10));
    const id = JSON.parse(sockets[0].sent[0]).id;
    sockets[0].reply(JSON.stringify({ id, ok: false, error: "unknown ref s1 — take a new snapshot" }));
    await expect(p).rejects.toThrow("unknown ref s1");
  });

  it("ignores non-JSON frames without failing pending requests", async () => {
    const { factory, sockets } = fakeSocketFactory();
    const client = new BridgeClient("ws://127.0.0.1:8757", factory);
    const p = client.send("list_tabs");
    await new Promise((r) => setTimeout(r, 10));
    sockets[0].reply("not json at all");
    const id = JSON.parse(sockets[0].sent[0]).id;
    sockets[0].reply(JSON.stringify({ id, ok: true, result: ["tab"] }));
    expect(await p).toEqual(["tab"]);
  });
});
