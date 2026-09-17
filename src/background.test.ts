/**
 * Tests for extension/background.js against a mocked chrome.* API and the
 * REAL host.mjs child process — the full WS → native-messaging → handler →
 * reply loop, without Chrome and without any debugger API (none is
 * registered).
 *
 * The mock port does exactly what Chrome does for native messaging: onMessage
 * receives parsed JSON objects, postMessage objects are framed onto stdin.
 * The mocked chrome.scripting.executeScript runs the REAL injected functions
 * from injected.js against a hand-built fake DOM, so snapshot → ref → click /
 * type / eval / console_logs are covered end to end at the handler level.
 *
 * The host child always runs with BROWSR_PORT=0 (ephemeral) so a live bridge
 * on the default port is never touched.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

// --- fake DOM + page globals for the injected functions ----------------------------

// Subclass the REAL Event: replacing globalThis.Event outright breaks Node's
// own WebSocket internals, which validate instanceof Event.
class FakePointerEvent extends Event {}
class FakeMouseEvent extends Event {}
// Carries the KeyboardEventInit dict as own props (the real constructor zeroes
// legacy keyCode, which dom_press patches back onto the event).
class FakeKeyboardEvent extends Event {
  constructor(type: string, init?: Record<string, unknown>) {
    super(type, init as EventInit | undefined);
    // defineProperty, not Object.assign: bubbles/cancelable are readonly
    // getters on Event.prototype, plain assignment throws in strict mode.
    for (const [k, v] of Object.entries(init ?? {})) {
      Object.defineProperty(this, k, { value: v, writable: true, configurable: true, enumerable: true });
    }
  }
}

interface FakeElement {
  tagName: string;
  nodeName: string;
  nodeType: number;
  children: FakeElement[];
  childNodes: FakeElement[];
  attributes: { name: string; value: string }[];
  nodeValue?: string;
  isContentEditable: boolean;
  value?: string;
  events: FakeEvent[];
  clicked: number;
  scrolled?: boolean;
  focused?: boolean;
  appendChild(child: FakeElement): FakeElement;
  scrollIntoView(): void;
  focus(): void;
  click(): void;
  dispatchEvent(e: FakeEvent): void;
  getBoundingClientRect(): { x: number; y: number; width: number; height: number };
}

function makeEl(tagName: string, attrs: Record<string, string> = {}): FakeElement {
  const el = {
    tagName,
    nodeName: tagName,
    nodeType: 1,
    children: [],
    childNodes: [],
    attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
    isContentEditable: false,
    events: [],
    clicked: 0,
    appendChild(child: FakeElement) {
      // Real DOM: every node lands in childNodes, only elements in children.
      el.childNodes.push(child);
      if (child.nodeType === 1) el.children.push(child);
      return child;
    },
    scrollIntoView() {
      el.scrolled = true;
    },
    focus() {
      el.focused = true;
    },
    click() {
      el.clicked++;
    },
    dispatchEvent(e: FakeEvent) {
      el.events.push(e);
    },
    getBoundingClientRect() {
      return { x: 0, y: 0, width: 100, height: 50 };
    },
  } as unknown as FakeElement;
  return el;
}

function makeText(text: string): FakeElement {
  return { tagName: "#text", nodeName: "#text", nodeType: 3, nodeValue: text, children: [], attributes: [] } as unknown as FakeElement;
}

const html = makeEl("HTML");
const body = makeEl("BODY");
// What readPageText (the CSP-safe page_text path) reads back in tests.
const bodyText = "Docs link\nsearch box";
(body as unknown as Record<string, unknown>).innerText = bodyText;
const anchor = makeEl("A", { href: "https://example.com/", "aria-label": "Docs link" });
const input = makeEl("INPUT", { type: "text", placeholder: "search" });
input.value = "";

// Form fixtures for select_option / set_checked / press: live-ish state whose
// click() toggles like the real DOM, which the handlers verify after acting.
const opt1 = makeEl("OPTION", { value: "1" });
const opt2 = makeEl("OPTION", { value: "2" });
for (const [o, value, label] of [
  [opt1, "1", "  Option 1  "],
  [opt2, "2", "  Option 2  "],
] as Array<[FakeElement, string, string]>) {
  (o as unknown as Record<string, unknown>).value = value;
  (o as unknown as Record<string, unknown>).textContent = label;
  (o as unknown as Record<string, unknown>).selected = false;
}
const selectEl = makeEl("SELECT");
selectEl.appendChild(opt1);
selectEl.appendChild(opt2);
// Real options reach their owning select through closest() — select_option
// accepts an option ref (the snapshot hands out refs for options).
for (const o of [opt1, opt2] as Array<FakeElement>) {
  (o as unknown as Record<string, unknown>).closest = (q: string) =>
    String(q).toLowerCase() === "select" ? selectEl : null;
}
(selectEl as unknown as Record<string, unknown>).options = [opt1, opt2];
Object.defineProperty(selectEl, "value", {
  configurable: true,
  get: () =>
    String(
      ([opt1, opt2] as Array<Record<string, unknown>>).find((o) => o.selected)?.value ?? ""
    ),
  set: (v: string) => {
    const opts = [opt1, opt2] as Array<Record<string, unknown>>;
    const hit = opts.find((o) => String(o.value) === String(v));
    for (const o of opts) o.selected = hit != null && o === hit;
  },
});

const checkbox = makeEl("INPUT", { type: "checkbox", name: "subscribe" });
(checkbox as unknown as Record<string, unknown>).checked = false;
(checkbox as unknown as Record<string, unknown>).click = () => {
  checkbox.clicked++;
  (checkbox as unknown as Record<string, unknown>).checked =
    !(checkbox as unknown as Record<string, unknown>).checked;
};

const radio1 = makeEl("INPUT", { type: "radio", name: "color" });
const radio2 = makeEl("INPUT", { type: "radio", name: "color" });
for (const [me, other] of [
  [radio1, radio2],
  [radio2, radio1],
] as Array<[FakeElement, FakeElement]>) {
  (me as unknown as Record<string, unknown>).checked = false;
  (me as unknown as Record<string, unknown>).click = () => {
    me.clicked++;
    (me as unknown as Record<string, unknown>).checked = true;
    (other as unknown as Record<string, unknown>).checked = false;
  };
}

const formField = makeEl("INPUT", { type: "text" });
let requestSubmits = 0;
(formField as unknown as Record<string, unknown>).form = {
  requestSubmit: () => requestSubmits++,
};

html.appendChild(body);
body.appendChild(anchor);
anchor.appendChild(makeText("Docs"));
body.appendChild(input);
body.appendChild(selectEl);
body.appendChild(checkbox);
body.appendChild(radio1);
body.appendChild(radio2);
body.appendChild(formField);

const fakeConsole = {
  entries: [] as unknown[],
  log: (...a: unknown[]) => fakeConsole.entries.push(["log", ...a]),
  warn: (...a: unknown[]) => fakeConsole.entries.push(["warn", ...a]),
  error: (...a: unknown[]) => fakeConsole.entries.push(["error", ...a]),
  info: (...a: unknown[]) => fakeConsole.entries.push(["info", ...a]),
  debug: (...a: unknown[]) => fakeConsole.entries.push(["debug", ...a]),
};
const fakeWindow: Record<string, unknown> = { console: fakeConsole };

const g = globalThis as unknown as Record<string, unknown>;
g.document = { documentElement: html, title: "Test Page", body };
g.window = fakeWindow;
g.PointerEvent = FakePointerEvent;
g.MouseEvent = FakeMouseEvent;
g.KeyboardEvent = FakeKeyboardEvent;

// --- chrome mock -------------------------------------------------------------------

interface MockPort {
  onMessageListener: ((msg: unknown) => void) | null;
  onDisconnectListener: (() => void) | null;
  posted: unknown[];
  onMessage: { addListener: (fn: (msg: unknown) => void) => void };
  onDisconnect: { addListener: (fn: () => void) => void };
  postMessage: (msg: unknown) => void;
}

const tabsFixture = [
  { id: 10, title: "Search", url: "https://example.com/search", active: true, windowId: 1 },
  { id: 11, title: "Docs", url: "https://example.com/docs", active: false, windowId: 1 },
];

const connectNativeCalls: MockPort[] = [];
let connectNativeAttempts = 0;
/** When > 0, the next that many connectNative calls throw (host missing). */
let connectNativeFailures = 0;
let lastError: { message: string } | undefined;
/** Hook fired (synchronously) whenever background.js posts to the native port. */
let onNativePost: ((msg: unknown) => void) | null = null;

/** What the mocked chrome.scripting.executeScript does with an injection spec. */
let scriptingImpl:
  | ((spec: { func: (...args: unknown[]) => unknown; args?: unknown[]; world?: string }) => unknown)
  | null = null;

function makePort(): MockPort {
  const port = {
    onMessageListener: null,
    onDisconnectListener: null,
    posted: [],
    onMessage: { addListener: (fn: (msg: unknown) => void) => (port.onMessageListener = fn) },
    onDisconnect: { addListener: (fn: () => void) => (port.onDisconnectListener = fn) },
    postMessage: (msg: unknown) => {
      port.posted.push(msg);
      onNativePost?.(msg);
    },
  };
  return port;
}

const listenerBags = () => ({ addListener: () => {} });

// The real manifest is the source of truth; the mock serves its version so
// background.js derives VERSION exactly as it does in Chrome.
const manifestVersion = JSON.parse(
  readFileSync(fileURLToPath(new URL("../extension/manifest.json", import.meta.url)), "utf8")
) as { version: string };

g.chrome = {
  runtime: {
    getManifest: () => ({ version: manifestVersion.version }),
    connectNative: (_name: string) => {
      connectNativeAttempts++;
      if (connectNativeFailures > 0) {
        connectNativeFailures--;
        throw new Error("Specified native messaging host not found.");
      }
      const p = makePort();
      connectNativeCalls.push(p);
      return p;
    },
    get lastError() {
      return lastError;
    },
    onStartup: listenerBags(),
    onInstalled: listenerBags(),
  },
  tabs: {
    query: (_q: unknown, cb: (tabs: unknown) => void) => cb(tabsFixture),
    get: (id: number, cb: (t: unknown) => void) => cb({ id, windowId: 1 }),
    create: (_o: unknown, cb: (t: unknown) => void) => cb({ id: 1, windowId: 1 }),
    update: (_id: number, _o: unknown, cb: (t: unknown) => void) => cb({ id: 1, windowId: 1 }),
    remove: (_id: number, cb: () => void) => cb(),
    captureVisibleTab: (_winId: number, _opts: unknown, cb: (url: string) => void) =>
      cb("data:image/png;base64,QUJD"),
    onUpdated: listenerBags(),
    onRemoved: listenerBags(),
  },
  windows: { update: (_id: number, _o: unknown, cb: () => void) => cb() },
  scripting: {
    executeScript: (
      spec: { func: (...args: unknown[]) => unknown; args?: unknown[] },
      cb: (results: { result: unknown }[]) => void,
    ) => {
      let result: unknown;
      try {
        result = scriptingImpl ? scriptingImpl(spec) : undefined;
      } catch {
        result = undefined;
      }
      cb([{ result }]);
    },
  },
};

// Import the service worker AFTER the chrome global exists — that is also the
// real order: the SW module evaluates with chrome already present. The default
// scripting impl runs the real injected functions against the fake DOM.
scriptingImpl = (spec) => spec.func(...(spec.args || []));
const { VERSION, BUILD } = await import("../extension/background.js");

const activePort = () => connectNativeCalls[connectNativeCalls.length - 1];

/** Drives one command through the handler and resolves the posted reply. */
function sendCommand(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    onNativePost = (m) => {
      onNativePost = null;
      resolve(m as Record<string, unknown>);
    };
    activePort().onMessageListener!(msg);
  });
}

// --- host.mjs helpers for the wire-level loop --------------------------------------

interface HostProcess {
  child: ChildProcessWithoutNullStreams;
  ws: WebSocket;
}

/** Spawns host.mjs (ephemeral port, private log) and connects one WS client. */
async function startHostWithClient(): Promise<HostProcess> {
  const hostUrl = new URL("./host/host.mjs", import.meta.url);
  const logPath = join(mkdtempSync(join(tmpdir(), "browsr-bg-test-")), "bridge.log");
  const child = spawn(process.execPath, [fileURLToPath(hostUrl)], {
    env: { ...process.env, BROWSR_PORT: "0", BROWSR_LOG: logPath },
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  cleanups.push(() => child.kill());

  const port = await new Promise<number>((resolve, reject) => {
    const started = Date.now();
    const timer = setTimeout(() => reject(new Error("host never logged its port")), 5000);
    const poll = setInterval(() => {
      if (!existsSync(logPath)) return;
      const m = /listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(readFileSync(logPath, "utf8"));
      if (m) {
        clearTimeout(timer);
        clearInterval(poll);
        resolve(Number(m[1]));
      } else if (Date.now() - started > 4900) {
        clearTimeout(timer);
        clearInterval(poll);
        reject(new Error("host log exists but never mentioned its port"));
      }
    }, 25);
  });

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("ws connect failed"));
  });
  cleanups.push(() => ws.close());
  return { child, ws };
}

/** Reads length-prefixed frames off the host's stdout, skipping bridge noise (pings). */
function nextStdoutFrame(child: ChildProcessWithoutNullStreams, timeoutMs = 5000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.stdout.off("data", onData);
      reject(new Error("no framed stdout within timeout"));
    }, timeoutMs);
    let buf = Buffer.alloc(0);
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4) {
        const len = buf.readUInt32LE(0);
        if (buf.length < 4 + len) break;
        const msg = JSON.parse(buf.subarray(4, 4 + len).toString("utf8"));
        buf = buf.subarray(4 + len);
        if (msg?.type === "ping") continue; // keepalive, not ours
        clearTimeout(timer);
        child.stdout.off("data", onData);
        resolve(msg);
      }
    };
    child.stdout.on("data", onData);
  });
}

function nextWsMessage(ws: WebSocket, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no ws message within timeout")), timeoutMs);
    ws.onmessage = (ev: MessageEvent) => {
      clearTimeout(timer);
      resolve(String(ev.data));
    };
  });
}

/** Frames one JSON object onto the host's stdin, the way Chrome does. */
function writeFrameToHost(child: ChildProcessWithoutNullStreams, msg: unknown) {
  const payload = Buffer.from(JSON.stringify(msg), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  child.stdin.write(Buffer.concat([header, payload]));
}

/**
 * Full round trip: WS frame in → host frames it to stdout → deliver it to the
 * extension's onMessage listener (as Chrome would) → the extension's reply via
 * port.postMessage is framed back onto the host's stdin → WS message out.
 */
async function roundTrip(host: HostProcess, request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { child, ws } = host;
  const stdoutFrame = nextStdoutFrame(child);
  ws.send(JSON.stringify(request));
  const forwarded = await stdoutFrame; // what Chrome would deliver to the port

  const replyPosted = new Promise<unknown>((resolve) => {
    onNativePost = (msg) => {
      onNativePost = null;
      resolve(msg);
    };
  });
  activePort().onMessageListener!(forwarded);
  writeFrameToHost(child, await replyPosted);
  return JSON.parse(await nextWsMessage(ws));
}

// --- tests -------------------------------------------------------------------------

describe("service worker boot", () => {
  it("connects the native host on startup and registers no debugger API", () => {
    expect(connectNativeCalls).toHaveLength(1);
    expect(activePort().onMessageListener).toBeTypeOf("function");
    expect((g.chrome as Record<string, unknown>).debugger).toBeUndefined();
  });

  // Written as chrome[.]debugger so this file cannot itself match the ban grep.
  const DEBUGGER_API = /chrome[.]debugger/;

  it("contains zero debugger-API usage — no attach anywhere", () => {
    const src = readFileSync(fileURLToPath(new URL("../extension/background.js", import.meta.url)), "utf8");
    expect(src).not.toMatch(DEBUGGER_API);
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../extension/manifest.json", import.meta.url)), "utf8"));
    expect(manifest.permissions).not.toContain("debugger");
    expect(manifest.permissions).toContain("scripting");
    expect(manifest.host_permissions).toContain("<all_urls>");
    expect(manifest.permissions.sort()).toEqual(["activeTab", "nativeMessaging", "scripting", "tabs"]);
  });
});

describe("full bridge loop (WS → host → NM → handler → reply)", () => {
  it("answers list_tabs sent with the canonical 'command' key", async () => {
    const host = await startHostWithClient();
    const reply = await roundTrip(host, { id: 1, command: "list_tabs" });
    expect(reply).toEqual({
      id: 1,
      ok: true,
      result: tabsFixture.map((t) => ({
        id: t.id,
        title: t.title,
        url: t.url,
        active: t.active,
        windowId: t.windowId,
      })),
    });
  }, 15000);

  it("fails loudly on a wrong wire key instead of hanging — the no-reply repro", async () => {
    const host = await startHostWithClient();
    // A probe using 'cmd' used to get silence until timeout; now it errors.
    const reply = await roundTrip(host, { id: 2, cmd: "list_tabs" });
    expect(reply).toMatchObject({
      id: 2,
      ok: false,
      error: expect.stringContaining("missing command key"),
    });
  }, 15000);

  it("fails loudly on unknown commands", async () => {
    const host = await startHostWithClient();
    const reply = await roundTrip(host, { id: 3, command: "no_such_command" });
    expect(reply).toMatchObject({ id: 3, ok: false, error: expect.stringContaining("unknown command") });
  }, 15000);
});

describe("scripting-based DOM handlers (fake DOM, real injected functions)", () => {
  const TAB = 77;

  it("snapshots via injected walk, wires refs to paths, installs the console hook", async () => {
    const reply = await sendCommand({ id: 10, command: "snapshot", tabId: TAB });
    expect(reply.ok).toBe(true);
    const yaml = (reply.result as { yaml: string }).yaml;
    expect(yaml).toContain('- document "Test Page"');
    expect(yaml).toContain("link"); // the anchor distilled with its role
    expect(fakeWindow.__browsrConsoleInstalled).toBe(true); // hook installed at snapshot time
  });

  it("clicks the element behind a ref through the injected click function", async () => {
    const reply = await sendCommand({ id: 11, command: "click", tabId: TAB, ref: "s1" });
    expect(reply).toMatchObject({ id: 11, ok: true, result: { clicked: true, ref: "s1", x: 50, y: 25 } });
    expect(anchor.clicked).toBe(1);
    expect(anchor.scrolled).toBe(true);
  });

  it("types into a field through the injected type function", async () => {
    const reply = await sendCommand({ id: 12, command: "type", tabId: TAB, ref: "s2", text: "hello" });
    expect(reply).toMatchObject({ id: 12, ok: true, result: { typed: true, ref: "s2" } });
    expect(input.value).toBe("hello");
    expect(input.events.map((e) => e.type)).toEqual(["input", "change"]);
    expect(input.focused).toBe(true);
  });

  it("evaluates code in the page and returns the value", async () => {
    const reply = await sendCommand({ id: 13, command: "eval", tabId: TAB, code: "1 + 1" });
    expect(reply).toEqual({ id: 13, ok: true, result: { value: 2 } });
  });

  it("evaluates in the MAIN world — MV3's extension CSP forbids eval in content scripts", async () => {
    // Live reading (real Chrome, https://example.com, which serves NO CSP of
    // its own): injecting evalInPage into the ISOLATED world dies with
    // "Evaluating a string as JavaScript violates the following Content
    // Security Policy directive ... 'unsafe-eval' is not an allowed source".
    // MV3 bans eval in every extension context, content scripts included;
    // only the page's own (often absent) CSP governs the MAIN world.
    let world: string | undefined;
    const prevImpl = scriptingImpl;
    scriptingImpl = (spec) => {
      world = spec.world;
      return prevImpl?.(spec);
    };
    try {
      const reply = await sendCommand({ id: 20, command: "eval", tabId: TAB, code: "1 + 1" });
      expect(reply).toEqual({ id: 20, ok: true, result: { value: 2 } });
      expect(world).toBe("MAIN");
    } finally {
      scriptingImpl = prevImpl;
    }
  });

  it("reads page text through the injected reader — no eval, ISOLATED world", async () => {
    // page_text used to be eval + "document.body.innerText" in the MAIN world,
    // which strict-CSP sites (LinkedIn, X) block; the dedicated command injects
    // a plain reader function instead, in the default ISOLATED world.
    let funcSource = "";
    let world: string | undefined;
    const prevImpl = scriptingImpl;
    scriptingImpl = (spec) => {
      funcSource = spec.func.toString();
      world = spec.world;
      return prevImpl?.(spec);
    };
    try {
      const reply = await sendCommand({ id: 21, command: "page_text", tabId: TAB });
      expect(reply).toEqual({ id: 21, ok: true, result: { text: bodyText, title: "Test Page", url: "" } });
      expect(funcSource).not.toContain("eval(");
      expect(world).toBe("ISOLATED"); // plain DOM read, MAIN not needed
    } finally {
      scriptingImpl = prevImpl;
    }
  });

  it("screenshots via captureVisibleTab and strips the data-url prefix", async () => {
    const reply = await sendCommand({ id: 14, command: "screenshot", tabId: TAB });
    expect(reply).toEqual({ id: 14, ok: true, result: { base64: "QUJD" } });
  });

  it("reads back console entries captured by the hook", async () => {
    fakeConsole.error("boom", { a: 1 });
    const reply = await sendCommand({ id: 15, command: "console_logs", tabId: TAB });
    const entries = (reply.result as { entries: { type: string; text: string }[] }).entries;
    expect(entries.at(-1)).toMatchObject({ type: "error", text: "boom {\"a\":1}" });
  });

  it("rejects unknown refs loudly", async () => {
    const reply = await sendCommand({ id: 16, command: "click", tabId: TAB, ref: "s99" });
    expect(reply).toMatchObject({ id: 16, ok: false, error: expect.stringContaining("unknown ref s99") });
  });
});

describe("native port reconnect", () => {
  afterEach(() => {
    vi.useRealTimers();
    lastError = undefined;
    connectNativeFailures = 0;
  });

  it("reconnects after the host dies, consuming lastError", async () => {
    vi.useFakeTimers();
    const before = connectNativeCalls.length;
    lastError = { message: "Native host has exited." };
    activePort().onDisconnectListener!(); // Chrome fires this when host.mjs dies
    expect(connectNativeCalls).toHaveLength(before); // not instantly —
    vi.advanceTimersByTime(2_000); // after the retry delay
    expect(connectNativeCalls).toHaveLength(before + 1); // fresh port, host respawned from disk
  });

  it("keeps retrying with growing backoff while the host cannot be spawned", async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const portsBefore = connectNativeCalls.length;
    const attemptsBefore = connectNativeAttempts;
    connectNativeFailures = 2; // first two respawn attempts find no host

    activePort().onDisconnectListener!();
    vi.advanceTimersByTime(2_000); // attempt 1 (2s) throws
    expect(connectNativeAttempts).toBe(attemptsBefore + 1);
    expect(connectNativeCalls).toHaveLength(portsBefore); // still no port
    vi.advanceTimersByTime(2_000); // backoff doubled to 4s — nothing yet
    expect(connectNativeAttempts).toBe(attemptsBefore + 1);
    vi.advanceTimersByTime(2_000); // attempt 2 (4s mark) throws
    expect(connectNativeAttempts).toBe(attemptsBefore + 2);
    vi.advanceTimersByTime(8_000); // 8s backoff elapses, this one succeeds
    expect(connectNativeCalls).toHaveLength(portsBefore + 1);
    errorSpy.mockRestore();
  });
});

describe("version instrumentation", () => {
  const TAB = 77;

  it("answers the version command loudly with version, build and the command list", async () => {
    const reply = await sendCommand({ id: 50, command: "version" });
    expect(reply).toMatchObject({ id: 50, ok: true, result: { version: VERSION, build: BUILD } });
    const commands = (reply.result as { commands: string[] }).commands;
    expect(commands).toEqual(expect.arrayContaining([
      "snapshot", "click", "type", "select_option", "set_checked", "press", "page_text", "eval", "version",
    ]));
  });

  it("every dom_snapshot self-reports the code version as its first line", async () => {
    const reply = await sendCommand({ id: 51, command: "snapshot", tabId: TAB });
    expect(reply.ok).toBe(true);
    const yaml = (reply.result as { yaml: string }).yaml;
    expect(yaml.split("\n")[0]).toBe(`- browsr ${VERSION}`);
  });

  it("VERSION derives from the manifest — extension card, version tool and snapshots cannot drift", async () => {
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL("../extension/manifest.json", import.meta.url)), "utf8")
    ) as { version: string };
    expect(VERSION).toBe(manifest.version);
  });
});

describe("interaction handlers (select_option / set_checked / press / type mode)", () => {
  const TAB = 77;
  // Ref layout after a snapshot, in DOM order: s1 anchor, s2 input,
  // s3 select, s4/s5 options, s6 checkbox, s7/s8 radios, s9 form field.

  beforeEach(async () => {
    const reply = await sendCommand({ id: 900, command: "snapshot", tabId: TAB });
    expect(reply.ok).toBe(true);
  });

  it("select_option by value selects, fires input+change, reports value/label/index", async () => {
    selectEl.events.length = 0;
    const reply = await sendCommand({ id: 31, command: "select_option", tabId: TAB, ref: "s3", value: "2" });
    expect(reply).toMatchObject({
      id: 31,
      ok: true,
      result: { selected: true, ref: "s3", value: "2", label: "Option 2", index: 1 },
    });
    expect(selectEl.events.map((e) => e.type)).toEqual(["input", "change"]);
    expect((opt2 as unknown as Record<string, unknown>).selected).toBe(true);
    expect((opt1 as unknown as Record<string, unknown>).selected).toBe(false);
  });

  it("select_option by label and by index work too", async () => {
    expect(
      await sendCommand({ id: 32, command: "select_option", tabId: TAB, ref: "s3", label: "Option 1" })
    ).toMatchObject({ ok: true, result: { value: "1", index: 0 } });
    expect(
      await sendCommand({ id: 33, command: "select_option", tabId: TAB, ref: "s3", index: 1 })
    ).toMatchObject({ ok: true, result: { value: "2" } });
  });

  it("set_checked checks a checkbox with one click and reports the state", async () => {
    const reply = await sendCommand({ id: 34, command: "set_checked", tabId: TAB, ref: "s6", checked: true });
    expect(reply).toMatchObject({
      id: 34,
      ok: true,
      result: { set: true, ref: "s6", kind: "checkbox", checked: true, name: "subscribe" },
    });
    expect(checkbox.clicked).toBe(1);
  });

  it("set_checked selects a radio, deselecting its sibling", async () => {
    const reply = await sendCommand({ id: 35, command: "set_checked", tabId: TAB, ref: "s8", checked: true });
    expect(reply).toMatchObject({ id: 35, ok: true, result: { set: true, kind: "radio", checked: true } });
    expect((radio2 as unknown as Record<string, unknown>).checked).toBe(true);
    expect((radio1 as unknown as Record<string, unknown>).checked).toBe(false);
  });

  it("press Enter on a field inside a form falls back to requestSubmit", async () => {
    const before = requestSubmits;
    const reply = await sendCommand({ id: 36, command: "press", tabId: TAB, ref: "s9", key: "enter" });
    expect(reply).toMatchObject({
      id: 36,
      ok: true,
      result: { pressed: true, ref: "s9", key: "Enter", path: "requestSubmit" },
    });
    expect(requestSubmits).toBe(before + 1);
    expect(formField.events.map((e) => e.type)).toEqual(["keydown", "keypress", "keyup"]);
  });

  it("type with mode replace reaches the injected function (overwrite)", async () => {
    input.events.length = 0;
    input.value = "old text";
    const reply = await sendCommand({ id: 37, command: "type", tabId: TAB, ref: "s2", text: "new", mode: "replace" });
    expect(reply).toMatchObject({ id: 37, ok: true, result: { typed: true, ref: "s2" } });
    expect(input.value).toBe("new"); // replaced, not appended
    expect(input.events.map((e) => e.type)).toEqual(["input", "change"]);
  });

  it("select_option accepts an OPTION ref (resolves to the owning select)", async () => {
    // Live regression: /dropdown answered "element is not a native <select>"
    // because the caller passed an option's ref, the only labeled thing in view.
    selectEl.events.length = 0;
    const reply = await sendCommand({ id: 42, command: "select_option", tabId: TAB, ref: "s5", label: "Option 2" });
    expect(reply).toMatchObject({
      id: 42,
      ok: true,
      result: { selected: true, ref: "s5", value: "2", label: "Option 2", index: 1 },
    });
    expect((opt2 as unknown as Record<string, unknown>).selected).toBe(true);
    expect((opt1 as unknown as Record<string, unknown>).selected).toBe(false);
  });

  it("set_checked reports a loud error when the injected function throws (no null crash)", async () => {
    // Chrome swallows a throw inside executeScript into result:null — the
    // handler must say so instead of crashing on r.kind ("reading 'kind'").
    const prev = scriptingImpl;
    scriptingImpl = () => {
      throw new Error("page exploded");
    };
    try {
      const reply = await sendCommand({ id: 43, command: "set_checked", tabId: TAB, ref: "s6", checked: true });
      expect(reply.ok).toBe(false);
      expect(String(reply.error)).toMatch(/injected .* threw|returned nothing/);
      expect(String(reply.error)).not.toMatch(/reading 'kind'/);
    } finally {
      scriptingImpl = prev;
    }
  });

  it("missing/invalid params fail loudly", async () => {
    expect(await sendCommand({ id: 38, command: "select_option", tabId: TAB, ref: "s3" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("select_option needs one of value, label, index"),
    });
    expect(await sendCommand({ id: 39, command: "press", tabId: TAB, ref: "s9" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("press needs a 'key'"),
    });
    expect(await sendCommand({ id: 40, command: "set_checked", tabId: TAB, ref: "s6", checked: "yes" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("set_checked needs a boolean 'checked'"),
    });
    expect(await sendCommand({ id: 41, command: "type", tabId: TAB, ref: "s2", text: "x", mode: "bogus" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("unknown mode 'bogus'"),
    });
  });
});
