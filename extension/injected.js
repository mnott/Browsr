/**
 * Functions injected into pages via chrome.scripting.executeScript.
 *
 * Each exported function must be fully self-contained: Chrome serializes the
 * function body and runs it in the page, so module-level constants and imports
 * are NOT available inside them (constants are inlined per function on
 * purpose). They use only ambient page globals (document, Event, ...).
 *
 * Exported so vitest can run them against a hand-built fake DOM — no Chrome,
 * no jsdom; the tests provide the few globals these functions touch.
 *
 * No debugger API anywhere: attach-free DOM access is the point.
 */

/**
 * Walks the live DOM and distills it into the tree shape snapshot.js
 * consumes: { nodeId, nodeName, nodeType, attrs, children }. Also returns
 * `paths` (nodeId → child-index path from document.documentElement) so later
 * click/type can navigate straight back to the element by index.
 * Runs in the ISOLATED world; the DOM is shared, the page's JS is not.
 */
export function walkDom() {
  const KEEP_ATTRS = new Set([
    "role", "aria-label", "name", "id", "placeholder", "href", "type", "value", "tabindex", "title", "alt",
    "aria-checked", "aria-selected",
  ]);
  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "LINK", "META", "HEAD"]);
  // Inlined on purpose (executeScript serializes function source only): the
  // input types whose live .value is typed text. Checkbox/radio/button values
  // are form payloads, not user text — they stay out of the snapshot.
  const TEXT_ENTRY_TYPES = new Set(["", "text", "search", "email", "url", "tel", "password", "number"]);
  let nextId = 1;
  const paths = {};

  const attrsOf = (el) => {
    const out = {};
    for (const a of el.attributes || []) {
      if (KEEP_ATTRS.has(a.name)) out[a.name] = a.value;
    }
    // Live properties, not just attributes: the checked/selected attributes
    // hold only the INITIAL state, not what the user did since. Same for
    // option values — the attribute is often absent while the property
    // defaults to the option text — and for typed field values, which never
    // reach the value attribute at all.
    if (el.checked !== undefined) out.checked = String(!!el.checked);
    if (el.selected !== undefined) out.selected = String(!!el.selected);
    const tag = String(el.tagName || "").toUpperCase();
    if (tag === "OPTION" && typeof el.value === "string") {
      out.value = el.value;
    }
    const inputType = String(el.type ?? out.type ?? "").toLowerCase(); // property, else attribute
    if (typeof el.value === "string" && el.value !== "" &&
        (tag === "TEXTAREA" || (tag === "INPUT" && TEXT_ENTRY_TYPES.has(inputType)))) {
      out.value = el.value;
    }
    return out;
  };

  const walk = (node, path, depth) => {
    // Deep cap guards runaway recursion; 200 sits well above real page
    // nesting (LinkedIn's utility-class stacks run past 60 — the old cap
    // silently dropped feed and comment text containers).
    if (!node || depth > 200) return null;
    const id = nextId++;
    paths[id] = path;
    const children = [];
    // Iterate childNodes, not children: in a real DOM Element.children never
    // holds text nodes, and the text is where accessible names come from.
    // Paths stay RAW indices into el.children so clickByPath/typeByPath can
    // navigate back — skipped tags still occupy their slot.
    const kids = node.childNodes || [];
    let elementIndex = 0;
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i];
      if (child.nodeType === 3) {
        const text = String(child.nodeValue ?? "").replace(/\s+/g, " ").trim();
        if (text) children.push({ nodeId: 0, nodeName: "#text", nodeType: 3, attrs: { text }, children: [] });
        continue;
      }
      if (child.nodeType !== 1) continue; // comments, doctype, ...
      const slot = elementIndex++;
      if (SKIP_TAGS.has(child.tagName)) continue;
      const distilled = walk(child, path.concat([slot]), depth + 1);
      if (distilled) children.push(distilled);
    }
    return { nodeId: id, nodeName: node.tagName, nodeType: node.nodeType, attrs: attrsOf(node), children };
  };

  const root = document.documentElement;
  const tree = {
    nodeId: nextId++,
    nodeName: "#document",
    nodeType: 9,
    attrs: {},
    children: root ? [walk(root, [], 0)].filter(Boolean) : [],
  };
  const title = document.title;
  if (title) tree.attrs.name = title;
  return { tree, paths };
}

/**
 * Clicks the element at a snapshot path: scrollIntoView, then the element's
 * own click(); a pointerdown/pointerup/click dispatch is the fallback for
 * elements that do not implement click(). Exactly one click fires either way.
 */
export function clickByPath(path) {
  let el = document.documentElement;
  if (!el) return { clicked: false, error: "stale ref — take a new snapshot" };
  for (const i of path) {
    const next = el.children[i];
    if (!next) return { clicked: false, error: "stale ref — take a new snapshot" };
    el = next;
  }
  if (!el || el.nodeType !== 1) return { clicked: false, error: "stale ref — take a new snapshot" };
  el.scrollIntoView({ block: "center", inline: "center" });
  if (typeof el.click === "function") {
    el.click();
  } else {
    const r = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, view: window, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
    el.dispatchEvent(new PointerEvent("pointerdown", opts));
    el.dispatchEvent(new PointerEvent("pointerup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
  }
  const r = el.getBoundingClientRect();
  return { clicked: true, x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/**
 * Types text into the element at a snapshot path. Form fields get the value
 * set through the native setter (so framework listeners see it) plus
 * input/change events; contenteditable elements (and anything caret-oriented)
 * get document.execCommand("insertText") at the caret.
 *
 * mode: "append" (default — byte-identical to the historical behaviour),
 * "replace" (clear the field first / select all contenteditable contents so
 * the final value is exactly `text`), or "insert" (insert at the caret; on a
 * field that equals append, because value properties have no caret).
 */
export function typeByPath(path, text, mode) {
  let el = document.documentElement;
  if (!el) return { typed: false, error: "stale ref — take a new snapshot" };
  for (const i of path) {
    const next = el.children[i];
    if (!next) return { typed: false, error: "stale ref — take a new snapshot" };
    el = next;
  }
  if (el.nodeType !== 1) return { typed: false, error: "stale ref — take a new snapshot" };
  const m = mode === undefined || mode === null ? "append" : String(mode);
  if (m !== "append" && m !== "replace" && m !== "insert") {
    return { typed: false, error: `unknown mode '${m}' (append | replace | insert)` };
  }
  el.scrollIntoView({ block: "center", inline: "center" });
  if (typeof el.focus === "function") el.focus();
  if (typeof el.value === "string") {
    const proto = Object.getPrototypeOf(el) || {};
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    const setVal = (v) => (setter ? setter.call(el, v) : (el.value = v));
    if (m === "replace") setVal(""); // clear first; one input+change pair follows
    setVal(el.value + text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { typed: true };
  }
  if (el.isContentEditable) {
    if (typeof document.execCommand !== "function") {
      return { typed: false, error: "document.execCommand is unavailable — cannot type into this contenteditable element" };
    }
    if (m === "replace") {
      // Select all contents; insertText over an active selection replaces it.
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = document.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
    if (!document.execCommand("insertText", false, text)) {
      return { typed: false, error: 'execCommand("insertText") returned false — text was not inserted' };
    }
    return { typed: true };
  }
  return { typed: false, error: "element is not typable (no value property, not contenteditable)" };
}

/**
 * Picks an option in a native <select> at a snapshot path. selector is
 * { value?, label?, index? } — exactly one used; if several are given,
 * value wins over label over index. Sets the value through the native setter
 * and fires input + change. Custom ARIA listbox/combobox widgets are not
 * supported (v1 scope): the error says so and points at click flows.
 */
export function selectOptionByPath(path, selector) {
  let el = document.documentElement;
  if (!el) return { selected: false, error: "stale ref — take a new snapshot" };
  for (const i of path) {
    const next = el.children[i];
    if (!next) return { selected: false, error: "stale ref — take a new snapshot" };
    el = next;
  }
  if (String(el.tagName || "").toUpperCase() !== "SELECT") {
    // The snapshot hands out refs for options (often the only labeled thing
    // in a select), so an option ref is as good as the select's own ref —
    // resolve the owning select. Anything else really is not a native select.
    const owner = typeof el.closest === "function" ? el.closest("select") : null;
    if (owner && String(owner.tagName || "").toUpperCase() === "SELECT") el = owner;
    else {
      return {
        selected: false,
        error: "element is not a native <select> — custom ARIA listbox/combobox widgets are not supported by this tool; use dom_click on the widget's options instead",
      };
    }
  }
  const sel = selector && typeof selector === "object" ? selector : {};
  const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  const options = el.options || [];
  const has = (v) => v !== undefined && v !== null;
  let opt = null;
  let idx = -1;
  if (has(sel.value)) {
    for (let i = 0; i < options.length; i++) {
      if (String(options[i].value) === String(sel.value)) { opt = options[i]; idx = i; break; }
    }
  } else if (has(sel.label)) {
    for (let i = 0; i < options.length; i++) {
      if (norm(options[i].textContent) === String(sel.label)) { opt = options[i]; idx = i; break; }
    }
  } else if (has(sel.index)) {
    const i = Number(sel.index);
    if (Number.isInteger(i) && i >= 0 && i < options.length) { opt = options[i]; idx = i; }
  }
  if (!opt) {
    const given = has(sel.value) ? `value='${sel.value}'`
      : has(sel.label) ? `label='${sel.label}'`
      : has(sel.index) ? `index='${sel.index}'`
      : "no value/label/index given";
    const list = Array.prototype.slice.call(options, 0, 20)
      .map((o) => `value=${o.value} label=${norm(o.textContent)}`)
      .join("; ");
    return { selected: false, error: `no option matches ${given}; available options: ${list || "(none)"}` };
  }
  const proto = Object.getPrototypeOf(el) || {};
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, opt.value);
  else el.value = opt.value;
  try { opt.selected = true; } catch (e) { /* real DOM sets it via value already */ }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { selected: true, value: String(opt.value), label: norm(opt.textContent), index: idx };
}

/**
 * Sets the checked state of a checkbox or radio at a snapshot path. A real
 * click both flips the property AND runs the page's own handlers, so the
 * click only happens when the state actually differs — and the state is
 * verified after. Radios cannot be unchecked; the error says what to do.
 */
export function setCheckedByPath(path, checked) {
  let el = document.documentElement;
  if (!el) return { set: false, error: "stale ref — take a new snapshot" };
  for (const i of path) {
    const next = el.children[i];
    if (!next) return { set: false, error: "stale ref — take a new snapshot" };
    el = next;
  }
  if (el.nodeType !== 1) return { set: false, error: "stale ref — take a new snapshot" };
  // getAttribute, not attributes.find: NamedNodeMap is iterable but carries no
  // array methods, and .find on it throws inside the page (Chrome then swallows
  // the throw into a null result and the handler crashed on it).
  const getAttr = (node, name) =>
    typeof node.getAttribute === "function"
      ? node.getAttribute(name)
      : (node.attributes || []).find((a) => a.name === name)?.value;
  const kind = String(el.type ?? getAttr(el, "type") ?? "").toLowerCase();
  const want = !!checked;
  const nameOf = (node) => getAttr(node, "name");
  if (kind !== "checkbox" && kind !== "radio") {
    return { set: false, error: `element is not a checkbox or radio (type '${kind || "none"}')` };
  }
  el.scrollIntoView({ block: "center", inline: "center" });
  if (kind === "radio") {
    if (!want) {
      return { set: false, error: "radio buttons cannot be unchecked — pick a different radio in the group or reload" };
    }
    if (!el.checked) {
      el.click();
      if (!el.checked) return { set: false, error: "radio state did not change after click" };
    }
    return { set: true, kind, checked: !!el.checked, ...(nameOf(el) != null ? { name: nameOf(el) } : {}) };
  }
  if (el.checked !== want) {
    el.click();
    if (el.checked !== want) return { set: false, error: "checkbox state did not change after click" };
  }
  return { set: true, kind, checked: !!el.checked, ...(nameOf(el) != null ? { name: nameOf(el) } : {}) };
}

/**
 * Presses a key at the element for a snapshot path (or the focused element
 * when path is null): keydown, then keypress for printables + Enter, then
 * keyup — all cancelable and bubbling. Synthesized key events never trigger
 * browser default actions, so for an uncancelled Enter inside a reachable
 * form the function falls back to form.requestSubmit() and reports which
 * path fired ("requestSubmit" vs "keys").
 */
export function pressKeyByPath(path, key) {
  // Inlined on purpose: this function crosses the executeScript serialization
  // boundary as source only — no module-level constants come along.
  const KEY_MAP = {
    enter: { key: "Enter", code: "Enter", keyCode: 13 },
    tab: { key: "Tab", code: "Tab", keyCode: 9 },
    escape: { key: "Escape", code: "Escape", keyCode: 27 },
    backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
    delete: { key: "Delete", code: "Delete", keyCode: 46 },
    arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
    arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
    arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
    arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
    home: { key: "Home", code: "Home", keyCode: 36 },
    end: { key: "End", code: "End", keyCode: 35 },
    pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
    pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
    space: { key: " ", code: "Space", keyCode: 32 },
  };
  const KEY_NAMES = "enter, tab, escape, backspace, delete, arrowup, arrowdown, arrowleft, arrowright, home, end, pageup, pagedown, space, or any single character";
  const name = String(key ?? "").toLowerCase();
  let spec = KEY_MAP[name];
  if (!spec && String(key).length === 1) {
    const c = String(key);
    if (c === " ") spec = KEY_MAP.space;
    else {
      const upper = c.toUpperCase();
      spec = { key: c, code: /[a-z]/i.test(c) ? "Key" + upper : "Digit" + c, keyCode: upper.charCodeAt(0) };
    }
  }
  if (!spec) return { pressed: false, error: `unsupported key '${key}' — supported: ${KEY_NAMES}` };

  let el;
  if (path) {
    el = document.documentElement;
    if (!el) return { pressed: false, error: "stale ref — take a new snapshot" };
    for (const i of path) {
      const next = el.children[i];
      if (!next) return { pressed: false, error: "stale ref — take a new snapshot" };
      el = next;
    }
    if (el.nodeType !== 1) return { pressed: false, error: "stale ref — take a new snapshot" };
  } else {
    el = document.activeElement || document.body;
  }
  if (!el || el.nodeType !== 1) {
    return { pressed: false, error: "no element to press on (no ref given, nothing focused)" };
  }
  if (typeof el.focus === "function") el.focus();
  const fire = (type) => {
    const ev = new KeyboardEvent(type, {
      key: spec.key, code: spec.code, keyCode: spec.keyCode, bubbles: true, cancelable: true,
    });
    // KeyboardEventInit has no keyCode (legacy) and Chrome zeroes it — patch
    // it so legacy key handlers see the real code.
    try {
      Object.defineProperty(ev, "keyCode", { get: () => spec.keyCode });
      Object.defineProperty(ev, "which", { get: () => spec.keyCode });
    } catch (e) { /* non-configurable somewhere — best effort */ }
    el.dispatchEvent(ev);
    return ev;
  };
  const keydown = fire("keydown");
  const printable = spec.key.length === 1 || spec.key === "Enter";
  if (printable) fire("keypress");
  fire("keyup");
  if (spec.key === "Enter" && !keydown.defaultPrevented) {
    const form = el.form || (typeof el.closest === "function" ? el.closest("form") : null);
    if (form && typeof form.requestSubmit === "function") {
      form.requestSubmit();
      return { pressed: true, key: spec.key, path: "requestSubmit" };
    }
  }
  return { pressed: true, key: spec.key, path: "keys" };
}

/**
 * Evaluates code in the page. Returns { ok, value } with the value pre-sanitized
 * to JSON (executeScript drops non-serializable returns outright).
 */
export function evalInPage(code) {
  try {
    const value = eval(code);
    try {
      JSON.stringify(value);
      return { ok: true, value: value === undefined ? null : value };
    } catch {
      return { ok: true, value: String(value) };
    }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * Patches console.log/info/warn/error/debug in the page (MAIN world) to append
 * to a window buffer, ring-capped. Idempotent. Installed at snapshot time so
 * console_logs has something to read back on demand.
 */
export function installConsoleHook() {
  const w = window;
  if (w.__browsrConsoleInstalled) return { installed: false, already: true };
  const CAP = 500;
  const buf = (w.__browsrConsole = Array.isArray(w.__browsrConsole) ? w.__browsrConsole : []);
  const textOf = (a) => {
    if (typeof a === "string") return a;
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  };
  for (const method of ["log", "info", "warn", "error", "debug"]) {
    const orig = w.console[method];
    if (typeof orig !== "function") continue;
    w.console[method] = function (...args) {
      try {
        buf.push({ source: "console", type: method, text: args.map(textOf).join(" "), timestamp: Date.now() });
        while (buf.length > CAP) buf.shift();
      } catch {
        /* never break the page's own logging */
      }
      return orig.apply(this, args);
    };
  }
  w.__browsrConsoleInstalled = true;
  return { installed: true };
}

/** Reads the console buffer back (MAIN world). */
export function readConsole() {
  return { entries: (window.__browsrConsole || []).slice(-500) };
}
