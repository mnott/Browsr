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
  selectOptionByPath,
  setCheckedByPath,
  pressKeyByPath,
  evalInPage,
  installConsoleHook,
  readConsole,
} from "../extension/injected.js";
import { buildSnapshot } from "../extension/snapshot.js";

// Subclass the REAL Event (replacing globalThis.Event breaks Node internals).
class FakePointerEvent extends Event {}
class FakeMouseEvent extends Event {}
// Carries the KeyboardEventInit dict as own props so tests can read what the
// injected code constructed (the real constructor zeroes legacy keyCode).
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
  g.KeyboardEvent = FakeKeyboardEvent;
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

// --- dom_type modes ----------------------------------------------------------

describe("typeByPath modes", () => {
  it("replace clears a field first: final value only, exactly one input+change pair", () => {
    const field = el("INPUT", { type: "text" });
    field.value = "ab";
    const path = [0, 1, page.div.children.length];
    append(page.div, field);
    const r = typeByPath(path, "cd", "replace");
    expect(r.typed).toBe(true);
    expect(field.value).toBe("cd");
    expect(field.events).toEqual(["input", "change"]); // ONE pair, final value in place
    expect(field.focused).toBe(true);
  });

  it("insert on a field behaves like append (value properties have no caret)", () => {
    const field = el("INPUT", { type: "text" });
    field.value = "ab";
    const path = [0, 1, page.div.children.length];
    append(page.div, field);
    expect(typeByPath(path, "cd", "insert").typed).toBe(true);
    expect(field.value).toBe("abcd");
  });

  it("replace on contenteditable selects all via the Selection API, then insertText", () => {
    const selectTargets: unknown[] = [];
    const addedRanges: unknown[] = [];
    const range = { selectNodeContents: (t: unknown) => selectTargets.push(t) };
    const selection = { removeAllRanges: () => {}, addRange: (r: unknown) => addedRanges.push(r) };
    page.document.createRange = () => range as unknown as Range;
    page.document.getSelection = () => selection as unknown as Selection;
    try {
      const r = typeByPath([0, 2], "new text", "replace"); // page.editor
      expect(r.typed).toBe(true);
      expect(selectTargets).toEqual([page.editor]); // select-all targeted the editor
      expect(addedRanges).toEqual([range]); // and became the active selection
      expect(editableExecArgs).toEqual(["insertText", "new text"]); // insertText over it
    } finally {
      delete page.document.createRange;
      delete page.document.getSelection;
    }
  });

  it("replace on contenteditable fails loudly when execCommand fails", () => {
    page.editor.execCommandResult = false;
    page.document.createRange = () => ({ selectNodeContents: () => {} }) as unknown as Range;
    page.document.getSelection = () => ({ removeAllRanges: () => {}, addRange: () => {} }) as unknown as Selection;
    try {
      const r = typeByPath([0, 2], "x", "replace");
      expect(r.typed).toBe(false);
      expect(r.error).toMatch(/insertText/);
    } finally {
      page.editor.execCommandResult = undefined;
      delete page.document.createRange;
      delete page.document.getSelection;
    }
  });

  it("rejects unknown modes loudly, touching nothing", () => {
    const field = el("INPUT", { type: "text" });
    field.value = "keep";
    const path = [0, 1, page.div.children.length];
    append(page.div, field);
    expect(typeByPath(path, "x", "bogus")).toEqual({
      typed: false,
      error: "unknown mode 'bogus' (append | replace | insert)",
    });
    expect(field.value).toBe("keep");
    expect(field.events).toEqual([]);
  });
});

// --- dom_select_option --------------------------------------------------------

/** A select whose value behaves like a real single-select (setter syncs options). */
function makeSelect(entries: Array<{ value: string; label: string }>): FakeEl {
  const s = el("SELECT");
  const rec = s as unknown as Record<string, unknown>;
  const opts: Array<Record<string, unknown>> = [];
  for (const { value, label } of entries) {
    const o = el("OPTION", { value });
    const r = o as unknown as Record<string, unknown>;
    r.value = value;
    r.textContent = `  ${label}  `; // the matcher trims/collapses option text
    r.selected = false;
    // Real options reach their owning select through closest()
    r.closest = (q: string) => (String(q).toLowerCase() === "select" ? s : null);
    append(s, o);
    opts.push(r);
  }
  rec.options = opts;
  Object.defineProperty(rec, "value", {
    configurable: true,
    get: () => String(opts.find((o) => o.selected)?.value ?? ""),
    set: (v: string) => {
      const hit = opts.find((o) => String(o.value) === String(v));
      for (const o of opts) o.selected = hit != null && o === hit;
    },
  });
  return s;
}

describe("selectOptionByPath", () => {
  const mount = (node: FakeEl): number[] => {
    const path = [0, 1, page.div.children.length];
    append(page.div, node);
    return path;
  };

  function freshSelect(): { s: FakeEl; path: number[] } {
    const s = makeSelect([
      { value: "1", label: "Option 1" },
      { value: "2", label: "Option 2" },
    ]);
    return { s, path: mount(s) };
  }

  it("selects by value, fires input then change, returns value/label/index", () => {
    const { s, path } = freshSelect();
    const r = selectOptionByPath(path, { value: "2" });
    expect(r).toEqual({ selected: true, value: "2", label: "Option 2", index: 1 });
    expect(s.events).toEqual(["input", "change"]);
    expect((s as unknown as Record<string, unknown>).value).toBe("2");
    const opts = (s as unknown as Record<string, unknown>).options as Array<Record<string, unknown>>;
    expect(opts[1].selected).toBe(true);
    expect(opts[0].selected).toBe(false);
    expect(s.clicked).toBe(0); // no click — value setter + events only
  });

  it("selects by exact label (trimmed/collapsed text, case-sensitive)", () => {
    const { path } = freshSelect();
    expect(selectOptionByPath(path, { label: "Option 1" })).toEqual({
      selected: true,
      value: "1",
      label: "Option 1",
      index: 0,
    });
  });

  it("selects by index, bounds-checked", () => {
    const { path } = freshSelect();
    expect(selectOptionByPath(path, { index: 1 })).toMatchObject({ selected: true, value: "2" });
    expect(selectOptionByPath(path, { index: 9 }).selected).toBe(false);
  });

  it("value wins over label when several selectors are given", () => {
    const { path } = freshSelect();
    expect(selectOptionByPath(path, { value: "2", label: "Option 1" })).toMatchObject({
      selected: true,
      value: "2",
    });
  });

  it("fails loudly when nothing matches, listing the available options", () => {
    const { path } = freshSelect();
    const r = selectOptionByPath(path, { value: "9" });
    expect(r.selected).toBe(false);
    expect(r.error).toContain("value=1 label=Option 1");
    expect(r.error).toContain("value=2 label=Option 2");
  });

  it("fails loudly when no selector key is given at all", () => {
    const { path } = freshSelect();
    const r = selectOptionByPath(path, {});
    expect(r.selected).toBe(false);
    expect(r.error).toContain("value=1 label=Option 1");
  });

  it("refuses non-SELECT elements honestly (custom listbox widgets)", () => {
    const path = mount(el("DIV", { role: "listbox" }));
    const r = selectOptionByPath(path, { value: "1" });
    expect(r.selected).toBe(false);
    expect(r.error).toMatch(/not a native <select>/);
    expect(r.error).toMatch(/dom_click/); // points at the workable alternative
  });

  it("accepts an OPTION ref — resolves the owning select via closest()", () => {
    // The snapshot hands out refs for options (the select line can be bare);
    // the caller naturally passes whichever option ref it picked.
    const { s, path } = freshSelect();
    const opts = (s as unknown as Record<string, unknown>).options as Array<Record<string, unknown>>;
    const optionPath = path.concat([1]); // second option child of the select
    const r = selectOptionByPath(optionPath, { label: "Option 2" });
    expect(r).toMatchObject({ selected: true, value: "2", label: "Option 2", index: 1 });
    expect(opts[1].selected).toBe(true);
    expect(opts[0].selected).toBe(false);
    expect(s.events).toEqual(["input", "change"]);
  });
});

// --- dom_set_checked ----------------------------------------------------------

/** Input whose click() toggles/selects like the real DOM does. */
function makeCheckable(
  type: "checkbox" | "radio",
  attrs: Record<string, string> = {},
  group: FakeEl[] = []
): FakeEl {
  const node = el("INPUT", { type, ...attrs });
  const rec = node as unknown as { checked: boolean; clicked: number };
  rec.checked = false;
  (node as unknown as Record<string, unknown>).click = () => {
    rec.clicked++;
    if (type === "checkbox") {
      rec.checked = !rec.checked;
    } else {
      rec.checked = true; // selecting a radio clears its group
      for (const sib of group) {
        if (sib !== node) (sib as unknown as { checked: boolean }).checked = false;
      }
    }
  };
  return node;
}

describe("setCheckedByPath", () => {
  const mount = (node: FakeEl): number[] => {
    const path = [0, 1, page.div.children.length];
    append(page.div, node);
    return path;
  };

  it("checks an unchecked checkbox with exactly one click, then verifies", () => {
    const cb = makeCheckable("checkbox", { name: "vehicle" });
    const r = setCheckedByPath(mount(cb), true);
    expect(r).toEqual({ set: true, kind: "checkbox", checked: true, name: "vehicle" });
    expect((cb as unknown as { clicked: number }).clicked).toBe(1);
  });

  it("does not click when the checkbox already holds the target state", () => {
    const cb = makeCheckable("checkbox");
    (cb as unknown as { checked: boolean }).checked = true;
    const r = setCheckedByPath(mount(cb), true);
    expect(r).toMatchObject({ set: true, checked: true });
    expect((cb as unknown as { clicked: number }).clicked).toBe(0);
  });

  it("unchecks a checked checkbox", () => {
    const cb = makeCheckable("checkbox");
    (cb as unknown as { checked: boolean }).checked = true;
    expect(setCheckedByPath(mount(cb), false)).toMatchObject({ set: true, checked: false });
    expect((cb as unknown as { clicked: number }).clicked).toBe(1);
  });

  it("fails loudly when the click did not change the state", () => {
    const cb = el("INPUT", { type: "checkbox" }); // click() does not toggle this one
    const r = setCheckedByPath(mount(cb), true);
    expect(r.set).toBe(false);
    expect(r.error).toMatch(/did not change/);
  });

  it("selects a radio and reports the resulting group state", () => {
    const r1 = makeCheckable("radio", { name: "color" });
    const r2 = makeCheckable("radio", { name: "color" }, []);
    // wire the group both ways
    (r1 as unknown as { click: () => void }).click = () => {
      (r1 as unknown as { clicked: number }).clicked++;
      (r1 as unknown as { checked: boolean }).checked = true;
      (r2 as unknown as { checked: boolean }).checked = false;
    };
    (r2 as unknown as { click: () => void }).click = () => {
      (r2 as unknown as { clicked: number }).clicked++;
      (r2 as unknown as { checked: boolean }).checked = true;
      (r1 as unknown as { checked: boolean }).checked = false;
    };
    mount(r1);
    const r = setCheckedByPath(mount(r2), true);
    expect(r).toMatchObject({ set: true, kind: "radio", checked: true, name: "color" });
    expect((r2 as unknown as { checked: boolean }).checked).toBe(true);
    expect((r1 as unknown as { checked: boolean }).checked).toBe(false); // sibling deselected
  });

  it("does not re-click an already selected radio", () => {
    const r1 = makeCheckable("radio", { name: "size" });
    (r1 as unknown as { checked: boolean }).checked = true;
    const r = setCheckedByPath(mount(r1), true);
    expect(r).toMatchObject({ set: true, checked: true });
    expect((r1 as unknown as { clicked: number }).clicked).toBe(0);
  });

  it("refuses to uncheck a radio loudly", () => {
    const r1 = makeCheckable("radio", { name: "size" });
    const res = setCheckedByPath(mount(r1), false);
    expect(res.set).toBe(false);
    expect(res.error).toMatch(/cannot be unchecked/);
  });

  it("refuses non-checkable elements loudly", () => {
    const res = setCheckedByPath(mount(el("DIV", { role: "checkbox" })), true);
    expect(res.set).toBe(false);
    expect(res.error).toMatch(/not a checkbox or radio/);
  });

  it("reads type/name via getAttribute — survives real NamedNodeMap attributes (no array methods)", () => {
    // Live regression: on the real /checkboxes page the injected function
    // threw "el.attributes.find is not a function" (NamedNodeMap is not an
    // Array), Chrome swallowed the throw into a null result, and the handler
    // crashed on r.kind. Real elements carry getAttribute — use it.
    const cb = el("INPUT", {});
    const raw = [
      { name: "type", value: "checkbox" },
      { name: "name", value: "vehicle" },
    ];
    const rec = cb as unknown as Record<string, unknown>;
    rec.attributes = {
      // iterable like NamedNodeMap, but with NO .find — exactly the real quirk
      *[Symbol.iterator]() {
        yield* raw;
      },
    };
    rec.getAttribute = (n: string) => raw.find((a) => a.name === n)?.value ?? null;
    rec.checked = false;
    cb.click = () => {
      cb.clicked++;
      rec.checked = true;
    };
    const r = setCheckedByPath(mount(cb), true);
    expect(r).toEqual({ set: true, kind: "checkbox", checked: true, name: "vehicle" });
    expect(cb.clicked).toBe(1);
  });
});

// --- dom_press ----------------------------------------------------------------

interface KeyRecord {
  type: string;
  key: unknown;
  code: unknown;
  keyCode: unknown;
  bubbles: unknown;
  cancelable: unknown;
  defaultPrevented: unknown;
}

/** Input that records the full init dict of every dispatched KeyboardEvent. */
function makeKeyTarget(attrs: Record<string, string> = {}): { t: FakeEl; recs: KeyRecord[] } {
  const t = el("INPUT", attrs);
  const recs: KeyRecord[] = [];
  const listeners: Array<(e: Event) => void> = [];
  (t as unknown as Record<string, unknown>).dispatchEvent = (e: Event) => {
    const ev = e as unknown as Record<string, unknown>;
    recs.push({
      type: String(ev.type),
      key: ev.key,
      code: ev.code,
      keyCode: ev.keyCode,
      bubbles: ev.bubbles,
      cancelable: ev.cancelable,
      defaultPrevented: ev.defaultPrevented,
    });
    for (const l of listeners) l(e);
  };
  (t as unknown as Record<string, unknown>).__listeners = listeners;
  return { t, recs };
}

describe("pressKeyByPath", () => {
  const mount = (node: FakeEl): number[] => {
    const path = [0, 1, page.div.children.length];
    append(page.div, node);
    return path;
  };

  it("dispatches keydown/keypress/keyup with key, code, keyCode, bubbles, cancelable", () => {
    const { t, recs } = makeKeyTarget({ type: "text" });
    const r = pressKeyByPath(mount(t), "a");
    expect(r).toEqual({ pressed: true, key: "a", path: "keys" });
    expect(recs.map((x) => x.type)).toEqual(["keydown", "keypress", "keyup"]);
    for (const x of recs) {
      expect(x).toMatchObject({ key: "a", code: "KeyA", keyCode: 65, bubbles: true, cancelable: true });
    }
  });

  it("maps named keys: enter 13 with code Enter, digits via Digit<", () => {
    const { t: t1, recs: recs1 } = makeKeyTarget();
    pressKeyByPath(mount(t1), "enter");
    expect(recs1.map((x) => x.type)).toEqual(["keydown", "keypress", "keyup"]); // Enter is printable-ish
    for (const x of recs1) expect(x).toMatchObject({ key: "Enter", code: "Enter", keyCode: 13 });

    const { t: t2, recs: recs2 } = makeKeyTarget();
    pressKeyByPath(mount(t2), "5");
    for (const x of recs2) expect(x).toMatchObject({ key: "5", code: "Digit5", keyCode: 53 });
  });

  it("skips keypress for non-printable keys (arrows)", () => {
    const { t, recs } = makeKeyTarget();
    pressKeyByPath(mount(t), "arrowdown");
    expect(recs.map((x) => x.type)).toEqual(["keydown", "keyup"]);
    for (const x of recs) expect(x).toMatchObject({ key: "ArrowDown", keyCode: 40 });
  });

  it("Enter inside a form falls back to requestSubmit and reports which path fired", () => {
    const { t, recs } = makeKeyTarget();
    let submits = 0;
    (t as unknown as Record<string, unknown>).form = { requestSubmit: () => submits++ };
    const r = pressKeyByPath(mount(t), "enter");
    expect(r).toEqual({ pressed: true, key: "Enter", path: "requestSubmit" });
    expect(submits).toBe(1); // exactly one submit, never both paths
    expect(recs.map((x) => x.type)).toEqual(["keydown", "keypress", "keyup"]); // keys fired too
  });

  it("a cancelled keydown leaves handling to the page (no requestSubmit)", () => {
    const { t } = makeKeyTarget();
    let submits = 0;
    (t as unknown as Record<string, unknown>).form = { requestSubmit: () => submits++ };
    ((t as unknown as Record<string, unknown>).__listeners as Array<(e: Event) => void>).push((e) => {
      if (e.type === "keydown") e.preventDefault();
    });
    const r = pressKeyByPath(mount(t), "enter");
    expect(r).toEqual({ pressed: true, key: "Enter", path: "keys" });
    expect(submits).toBe(0);
  });

  it("targets document.activeElement when no ref is given", () => {
    const { t, recs } = makeKeyTarget();
    page.document.activeElement = t;
    try {
      const r = pressKeyByPath(null, "escape");
      expect(r.pressed).toBe(true);
      expect(recs.map((x) => x.type)).toEqual(["keydown", "keyup"]); // Escape is not printable
      for (const x of recs) expect(x).toMatchObject({ key: "Escape", keyCode: 27 });
    } finally {
      delete page.document.activeElement;
    }
  });

  it("refuses unknown multi-character key names loudly, naming the supported keys", () => {
    const r = pressKeyByPath(null, "fnord");
    expect(r.pressed).toBe(false);
    expect(r.error).toMatch(/unsupported key 'fnord'/);
    expect(r.error).toContain("enter");
    expect(r.error).toContain("single character");
  });
});

// --- snapshot live-state exposure ---------------------------------------------

describe("walkDom live state exposure", () => {
  it("distills checked/selected live properties and option values", () => {
    const cb = el("INPUT", { type: "checkbox" });
    (cb as unknown as Record<string, unknown>).checked = true;

    const opt1 = el("OPTION", { value: "1" });
    const o1 = opt1 as unknown as Record<string, unknown>;
    o1.value = "1";
    o1.selected = false;
    append(opt1, text("Option 1"));
    const opt2 = el("OPTION"); // no value ATTRIBUTE — the property defaults to text
    const o2 = opt2 as unknown as Record<string, unknown>;
    o2.value = "2";
    o2.selected = true;
    append(opt2, text("Option 2"));
    const select = el("SELECT");
    append(select, opt1, opt2);

    const radio = el("INPUT", { type: "radio", name: "choice" });
    (radio as unknown as Record<string, unknown>).checked = false;

    const bodyEl = el("BODY");
    append(bodyEl, cb, select, radio);
    const rootEl = el("HTML");
    append(rootEl, bodyEl);

    const g = globalThis as unknown as Record<string, unknown>;
    const prev = g.document;
    g.document = { documentElement: rootEl, title: "State" };
    try {
      const { tree } = walkDom();
      const bodyNode = tree.children[0].children[0];
      expect(bodyNode.children[0].attrs.checked).toBe("true"); // live property, not attribute
      const options = bodyNode.children[1].children;
      expect(options[0].attrs.selected).toBe("false");
      expect(options[0].attrs.value).toBe("1");
      expect(options[1].attrs.selected).toBe("true");
      expect(options[1].attrs.value).toBe("2"); // property, attribute absent
      expect(bodyNode.children[2].attrs.checked).toBe("false");
      expect(bodyNode.children[2].attrs.name).toBe("choice"); // radio group name kept
    } finally {
      g.document = prev;
    }
  });

  it("distills live values of text-entry inputs and textareas (value= in yaml)", () => {
    const field = el("INPUT", { type: "text" });
    (field as unknown as Record<string, unknown>).value = "42"; // typed — no value ATTRIBUTE
    const pwd = el("INPUT", { type: "password" });
    (pwd as unknown as Record<string, unknown>).value = "hunter2";
    const ta = el("TEXTAREA", {});
    (ta as unknown as Record<string, unknown>).value = "a note";
    const cb = el("INPUT", { type: "checkbox" });
    (cb as unknown as Record<string, unknown>).checked = true;
    (cb as unknown as Record<string, unknown>).value = "on"; // live .value exists but carries no typed text
    const radio = el("INPUT", { type: "radio", name: "choice" });
    (radio as unknown as Record<string, unknown>).value = "opt-1";

    const bodyEl = el("BODY");
    append(bodyEl, field, pwd, ta, cb, radio);
    const rootEl = el("HTML");
    append(rootEl, bodyEl);

    const g = globalThis as unknown as Record<string, unknown>;
    const prev = g.document;
    g.document = { documentElement: rootEl, title: "Values" };
    try {
      const { tree } = walkDom();
      const bodyNode = tree.children[0].children[0];
      expect(bodyNode.children[0].attrs.value).toBe("42"); // property, attribute absent
      expect(bodyNode.children[1].attrs.value).toBe("hunter2");
      expect(bodyNode.children[2].attrs.value).toBe("a note");
      expect(bodyNode.children[3].attrs.value).toBeUndefined(); // checkbox value is not typed text
      expect(bodyNode.children[4].attrs.value).toBeUndefined(); // radio value is not typed text

      const { yaml } = buildSnapshot(tree);
      expect(yaml).toContain('- textbox "42" [ref=s1 value=42]');
      expect(yaml).toContain('- radio "choice" [ref=s5 checked=false group=choice]'); // group name, not the value
    } finally {
      g.document = prev;
    }
  });

  it("keeps aria-checked/aria-selected attributes for widget roles", () => {
    const sw = el("DIV", { role: "switch", "aria-checked": "true" });
    const bodyEl = el("BODY");
    append(bodyEl, sw);
    const rootEl = el("HTML");
    append(rootEl, bodyEl);
    const g = globalThis as unknown as Record<string, unknown>;
    const prev = g.document;
    g.document = { documentElement: rootEl, title: "A11y" };
    try {
      const { tree, yaml } = walkThenBuild();
      expect(tree.children[0].children[0].children[0].attrs["aria-checked"]).toBe("true");
      expect(yaml).toContain("[ref=s1 checked=true]"); // honoured for switch-style widgets
    } finally {
      g.document = prev;
    }
  });

  function walkThenBuild(): { tree: ReturnType<typeof walkDom>["tree"]; yaml: string } {
    const { tree } = walkDom();
    const { yaml } = buildSnapshot(tree);
    return { tree, yaml };
  }
});

// --- serialization boundary for the new functions ------------------------------

describe("new injected functions across the executeScript serialization boundary", () => {
  const mount = (node: FakeEl): number[] => {
    const path = [0, 1, page.div.children.length];
    append(page.div, node);
    return path;
  };

  it("selectOptionByPath clone: no module-level state, selects by value", () => {
    const clone = eval(`(${selectOptionByPath.toString()})`) as typeof selectOptionByPath;
    const s = makeSelect([
      { value: "1", label: "Option 1" },
      { value: "2", label: "Option 2" },
    ]);
    expect(clone(mount(s), { value: "2" })).toEqual({ selected: true, value: "2", label: "Option 2", index: 1 });
  });

  it("setCheckedByPath clone toggles a checkbox", () => {
    const clone = eval(`(${setCheckedByPath.toString()})`) as typeof setCheckedByPath;
    const cb = makeCheckable("checkbox", { name: "clone" });
    expect(clone(mount(cb), true)).toEqual({ set: true, kind: "checkbox", checked: true, name: "clone" });
  });

  it("pressKeyByPath clone presses Enter with the requestSubmit fallback", () => {
    const clone = eval(`(${pressKeyByPath.toString()})`) as typeof pressKeyByPath;
    const { t, recs } = makeKeyTarget();
    let submits = 0;
    (t as unknown as Record<string, unknown>).form = { requestSubmit: () => submits++ };
    expect(clone(mount(t), "enter")).toEqual({ pressed: true, key: "Enter", path: "requestSubmit" });
    expect(submits).toBe(1);
    expect(recs.map((x) => x.type)).toEqual(["keydown", "keypress", "keyup"]);
  });

  it("typeByPath clone replaces a field value", () => {
    const clone = eval(`(${typeByPath.toString()})`) as typeof typeByPath;
    const field = el("INPUT", { type: "text" });
    field.value = "old";
    const path = mount(field);
    expect(clone(path, "new", "replace").typed).toBe(true);
    expect(field.value).toBe("new");
  });
});
