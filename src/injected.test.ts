/**
 * Unit tests for the page-injected functions (extension/injected.js) against
 * a hand-built fake DOM. These functions run in the page via
 * chrome.scripting.executeScript, so they must stay self-contained — which
 * is also what lets them run here with just a few fake globals.
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  walkDom,
  clickByPath,
  typeByPath,
  evalInPage,
  installConsoleHook,
  readConsole,
} from "../extension/injected.js";
import { buildSnapshot } from "../extension/snapshot.js";

// Subclass the REAL Event (replacing globalThis.Event breaks Node internals).
class FakePointerEvent extends Event {}
class FakeMouseEvent extends Event {}

interface FakeEl {
  tagName: string;
  nodeName: string;
  nodeType: number;
  children: FakeEl[];
  childNodes: FakeEl[];
  attributes: { name: string; value: string }[];
  nodeValue?: string;
  isContentEditable?: boolean;
  value?: string;
  events: string[];
  clicked: number;
  scrolled?: boolean;
  focused?: boolean;
  execCommandResult?: boolean;
}

function el(tagName: string, attrs: Record<string, string> = {}, extra: Partial<FakeEl> = {}): FakeEl {
  const node = {
    tagName,
    nodeName: tagName,
    nodeType: 1,
    children: [],
    childNodes: [],
    attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
    events: [],
    clicked: 0,
    ...extra,
  } as unknown as FakeEl & {
    scrollIntoView(): void;
    focus(): void;
    click(): void;
    dispatchEvent(e: Event): void;
    getBoundingClientRect(): { x: number; y: number; width: number; height: number };
  };
  (node as unknown as Record<string, unknown>).scrollIntoView = () => ((node as unknown as Record<string, unknown>).scrolled = true);
  (node as unknown as Record<string, unknown>).focus = () => ((node as unknown as Record<string, unknown>).focused = true);
  node.click = () => node.clicked++;
  node.dispatchEvent = (e: Event) => node.events.push(e.type);
  node.getBoundingClientRect = () => ({ x: 0, y: 0, width: 100, height: 50 });
  return node;
}

function text(t: string): FakeEl {
  return {
    tagName: "#text",
    nodeName: "#text",
    nodeType: 3,
    nodeValue: t,
    children: [],
    childNodes: [],
    attributes: [],
    events: [],
    clicked: 0,
  };
}

/**
 * Appends like the real DOM: every node lands in childNodes, but only element
 * nodes land in children — Element.children never contains text nodes.
 */
function append(parent: FakeEl, ...kids: FakeEl[]): void {
  for (const kid of kids) {
    parent.childNodes.push(kid);
    if (kid.nodeType === 1) parent.children.push(kid);
  }
}

let editableExecArgs: [string, string] | null = null;

const page = {
  root: el("HTML"),
  anchor: el("A", { href: "https://example.com/", "aria-label": "link" }),
  editor: el("DIV", { role: "textbox" }, { isContentEditable: true }),
  div: el("DIV", {}, {}),
  window: {} as Record<string, unknown>,
  document: {} as Record<string, unknown>,
};

beforeAll(() => {
  const body = el("BODY");
  append(page.root, body);
  append(body, page.anchor, page.div, page.editor);
  append(page.anchor, text("  spaced   text  "));

  // The few page globals the injected functions touch.
  const g = globalThis as unknown as Record<string, unknown>;
  g.PointerEvent = FakePointerEvent;
  g.MouseEvent = FakeMouseEvent;
  g.window = page.window;
  g.document = page.document;
  page.document.documentElement = page.root;
  page.document.title = "T";
  page.document.execCommand = (cmd: string, _show: boolean, value: string) => {
    editableExecArgs = [cmd, value];
    return page.editor.execCommandResult ?? true;
  };
});

describe("walkDom", () => {
  it("distills the tree, skips script/style, records index paths", () => {
    const script = el("SCRIPT");
    append(page.div, script, el("BUTTON", { type: "button" }));
    const { tree, paths } = walkDom();

    expect(tree.nodeName).toBe("#document");
    expect(tree.attrs.name).toBe("T"); // document.title becomes the name
    // html/body are transparent in yaml but present in the tree
    const html = tree.children[0];
    expect(html.nodeName).toBe("HTML");
    const body = html.children[0];
    expect(body.nodeName).toBe("BODY");

    const anchorNode = body.children[0];
    expect(anchorNode.nodeName).toBe("A");
    expect(anchorNode.attrs.href).toBe("https://example.com/");
    expect(anchorNode.children[0].attrs.text).toBe("spaced text"); // whitespace collapsed

    const button = body.children[1].children[0]; // div's children: script skipped
    expect(button.nodeName).toBe("BUTTON");

    // paths use RAW child indices under documentElement: the skipped SCRIPT
    // still occupies index 0 in div, so the button is [0,1,1].
    expect(paths[anchorNode.nodeId]).toEqual([0, 0]);
    expect(paths[button.nodeId]).toEqual([0, 1, 1]);
  });
});

describe("walkDom on a DOM-faithful page (text nodes live in childNodes)", () => {
  it("carries visible text into the snapshot: a link is named by its own text", () => {
    // In a real page, Element.children holds elements only — text is reachable
    // solely through childNodes. walkDom must read it there, or every name in
    // the YAML comes out empty (the live example.com symptom).
    const heading = el("H1");
    const para = el("P");
    const anchor = el("A", { href: "https://www.iana.org/domains/example" });
    append(heading, text("Example Domain"));
    append(para, text("This domain is for use in illustrative examples."));
    append(anchor, text("Learn more"));
    const body = el("BODY");
    append(body, heading, para, anchor);
    const root = el("HTML");
    append(root, body);

    const g = globalThis as unknown as Record<string, unknown>;
    const prev = g.document;
    g.document = { documentElement: root, title: "Example Domain" };
    try {
      const { tree } = walkDom();
      const { yaml } = buildSnapshot(tree);
      expect(yaml).toContain('- heading "Example Domain" [level=1]');
      expect(yaml).toContain('- text "This domain is for use in illustrative examples."');
      expect(yaml).toContain('- link "Learn more" [ref=s1]');
    } finally {
      g.document = prev;
    }
  });
});

describe("walkDom across the executeScript serialization boundary", () => {
  it("survives Chrome's func.toString() round trip: same tree, #text children intact", () => {
    // chrome.scripting.executeScript({func}) ships the function SOURCE and
    // re-creates it in the page — imports and outer bindings do not come
    // along. Reproduce that boundary here: the clone must distill the same
    // tree with its text children, so a regression to module-level state or
    // closure capture fails this test before it can fail in real Chrome.
    const heading = el("H1");
    const para = el("P");
    const anchor = el("A", { href: "https://iana.org/domains/example" });
    append(heading, text("Example Domain"));
    append(para, text("This domain is for use in documentation examples."));
    append(anchor, text("Learn more"));
    const body = el("BODY");
    append(body, heading, para, anchor);
    const root = el("HTML");
    append(root, body);

    const g = globalThis as unknown as Record<string, unknown>;
    const prev = g.document;
    g.document = { documentElement: root, title: "Example Domain" };
    try {
      const clonedWalkDom = eval(`(${walkDom.toString()})`) as typeof walkDom;
      const { tree, paths } = clonedWalkDom();
      const { yaml } = buildSnapshot(tree);
      expect(yaml).toContain('- heading "Example Domain" [level=1]');
      expect(yaml).toContain('- text "This domain is for use in documentation examples."');
      expect(yaml).toContain('- link "Learn more" [ref=s1]');
      expect(paths).toBeTruthy();
    } finally {
      g.document = prev;
    }
  });
});

describe("walkDom + buildSnapshot on the LinkedIn shape (text wrapped in spans)", () => {
  it("names links, headings and options from text nested in descendant elements", () => {
    // Live reading on a real profile page: `- link "" [ref=s16]` with a child
    // `- text "…"` — the anchor's text sits in a <span> child, not a direct
    // #text child, so accessibleName's ownText (direct #text children only)
    // is empty. Same for headings and options. The a11y rule is "name from
    // content": the subtree's text names the element, shallow levels first.
    const name = el("SPAN");
    append(name, text("Profile Owner"));
    const anchor = el("A", { href: "https://www.linkedin.com/in/" });
    append(anchor, name);
    const headline = el("SPAN");
    append(headline, text("Building browsr"));
    const heading = el("H2");
    append(heading, headline);
    const optionLabel = el("SPAN");
    append(optionLabel, text("English (English)"));
    const option = el("OPTION", { value: "en" });
    append(option, optionLabel);
    const select = el("SELECT");
    append(select, option);
    const body = el("BODY");
    append(body, anchor, heading, select);
    const root = el("HTML");
    append(root, body);

    const g = globalThis as unknown as Record<string, unknown>;
    const prev = g.document;
    g.document = { documentElement: root, title: "Profile | LinkedIn" };
    try {
      // Same eval boundary chrome.scripting applies: func source only.
      const clonedWalkDom = eval(`(${walkDom.toString()})`) as typeof walkDom;
      const { tree } = clonedWalkDom();
      const { yaml } = buildSnapshot(tree);
      expect(yaml).toContain('- link "Profile Owner" [ref=');
      expect(yaml).toContain('- heading "Building browsr" [level=2]');
      expect(yaml).toContain('- option "English (English)" [ref=');
    } finally {
      g.document = prev;
    }
  });
});

describe("buildSnapshot names interactive generics from nested content", () => {
  it("names a clickable div whose text sits one span down (comment bodies)", () => {
    // Live shape: comment body = interactive div > span > #text. Without
    // subtree naming every comment body reads as `- text ""`. Fixtures here
    // use the distilled tree shape ({attrs, children}) directly.
    const t = (s: string) => ({ nodeName: "#text", nodeType: 3, attrs: { text: s }, children: [] });
    const span = { nodeName: "SPAN", nodeType: 1, attrs: {}, children: [t("This comment is fully readable")] };
    const body = { nodeName: "DIV", nodeType: 1, attrs: { tabindex: "0" }, children: [span] };
    // Layout guard: a plain wrapper with the same nesting stays transparent
    // (no subtree naming for non-interactive generics).
    const inner = { nodeName: "SPAN", nodeType: 1, attrs: {}, children: [t("wrapper text")] };
    const wrapper = { nodeName: "DIV", nodeType: 1, attrs: {}, children: [inner] };
    const root = { nodeName: "HTML", nodeType: 1, attrs: {}, children: [body, wrapper] };

    const { yaml } = buildSnapshot({ nodeName: "#document", nodeType: 9, attrs: {}, children: [root] });
    expect(yaml).toContain('- text "This comment is fully readable" [ref=');
    expect(yaml).toContain('- text "wrapper text"'); // span itself still named
    expect(yaml.match(/- text ""/g) ?? []).toEqual([]); // nothing left unnamed here
  });
});

describe("walkDom depth reach", () => {
  it("distills text nested well below depth 60 (deep utility-class DOM)", () => {
    // Live symptom: feed/comment author rows render but their body text
    // containers come back childless — elements past the old depth>60 cap
    // were silently dropped. Real pages nest far deeper than 60.
    const root = el("HTML");
    let cursor = root;
    for (let i = 0; i < 90; i++) {
      const next = el("DIV");
      append(cursor, next);
      cursor = next;
    }
    append(cursor, text("text at depth 92"));
    const g = globalThis as unknown as Record<string, unknown>;
    const prev = g.document;
    g.document = { documentElement: root, title: "Deep" };
    try {
      const { tree } = walkDom();
      const { yaml } = buildSnapshot(tree);
      expect(yaml).toContain("text at depth 92");
    } finally {
      g.document = prev;
    }
  });
});

describe("clickByPath", () => {
  it("scrolls and clicks the element at a path", () => {
    const r = clickByPath([0, 0]);
    expect(r.clicked).toBe(true);
    expect(page.anchor.clicked).toBe(1);
    expect(page.anchor.scrolled).toBe(true);
  });

  it("reports stale paths loudly", () => {
    expect(clickByPath([9, 9])).toMatchObject({ clicked: false, error: expect.stringContaining("stale ref") });
  });

  it("falls back to dispatched pointer events when click() is missing", () => {
    const custom = el("X-BUTTON");
    (custom as unknown as Record<string, unknown>).click = undefined;
    append(page.div, custom);
    const r = clickByPath([0, 1, 2]); // after script(0) and button(1)
    expect(r.clicked).toBe(true);
    expect(custom.events).toEqual(["pointerdown", "pointerup", "click"]); // exactly one click
  });
});

describe("typeByPath", () => {
  it("appends via the value property and fires input + change", () => {
    const field = el("INPUT", { type: "text" });
    field.value = "ab";
    append(page.div, field);
    const r = typeByPath([0, 1, 3], "cd"); // after script(0), button(1), custom(2)
    expect(r.typed).toBe(true);
    expect(field.value).toBe("abcd");
    expect(field.events).toEqual(["input", "change"]);
    expect(field.focused).toBe(true);
  });

  it("inserts text at the caret for contenteditable elements", () => {
    const r = typeByPath([0, 2], "typed");
    expect(r.typed).toBe(true);
    expect(editableExecArgs).toEqual(["insertText", "typed"]);
  });

  it("refuses non-typable elements loudly", () => {
    const r = typeByPath([0, 1], "x"); // plain div
    expect(r.typed).toBe(false);
    expect(r.error).toMatch(/not typable/);
  });
});

describe("evalInPage", () => {
  it("returns values pre-sanitized to JSON", () => {
    expect(evalInPage("2 + 3")).toEqual({ ok: true, value: 5 });
    expect(evalInPage("({ a: 1 })")).toEqual({ ok: true, value: { a: 1 } });
    expect(evalInPage("undefined")).toEqual({ ok: true, value: null });
  });

  it("reports thrown errors", () => {
    expect(evalInPage("throw new Error('nope')")).toMatchObject({ ok: false, error: "nope" });
  });
});

describe("console hook", () => {
  it("captures console calls into the window buffer, idempotently", () => {
    const calls: string[] = [];
    page.window.console = {
      log: (...a: unknown[]) => calls.push(`log:${a.join(" ")}`),
      warn: () => {},
      error: () => {},
      info: () => {},
      debug: () => {},
    };
    expect(installConsoleHook()).toEqual({ installed: true });
    expect(installConsoleHook()).toEqual({ installed: false, already: true }); // no double wrap

    (page.window.console as Record<string, (...a: unknown[]) => void>).log("hi", { x: 1 });
    expect(calls).toEqual(["log:hi [object Object]"]); // original still invoked, once

    const entries = readConsole().entries as { type: string; text: string }[];
    expect(entries.at(-1)).toMatchObject({ type: "log", text: "hi {\"x\":1}" });
  });

  it("reads an empty buffer before anything is captured", () => {
    page.window.__browsrConsole = undefined;
    expect(readConsole()).toEqual({ entries: [] });
  });
});
