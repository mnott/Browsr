/**
 * Snapshot builder — the single source of truth for the a11y-tree YAML that
 * dom_snapshot returns. Pure functions, no chrome.* access, imported by
 * background.js AND by vitest.
 *
 * Input: a distilled DOM tree (see walkDom in injected.js):
 *   { nodeId, nodeName, nodeType, attrs: {...}, children: [...] }
 *   attrs keys: role, aria-label, name, id, placeholder, href, type, value,
 *   text, tabindex, click, alt, title  (all optional; absent = not set)
 *
 * Output:
 *   yaml   — one line per rendered element, 2-space indent per depth
 *   refMap — { "s1": <DOM node id>, ... } for the refs emitted in this yaml
 *
 * Refs are per-snapshot: a fresh buildSnapshot() starts the counter at s1
 * again. They stay valid only until the next snapshot or navigation on that
 * tab; resolving a ref afterwards is background.js's problem (error).
 */

const INTERACTIVE_ROLES = new Set([
  "link",
  "button",
  "textbox",
  "checkbox",
  "radio",
  "combobox",
  "tab",
  "menuitem",
  "option",
  "slider",
  "switch",
  "searchbox",
  "listbox",
  "spinbutton",
  "treeitem",
  "progressbar",
  "scrollbar",
]);

const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

const TEXTBOX_INPUT_TYPES = new Set([
  "text",
  "search",
  "email",
  "url",
  "tel",
  "password",
  "number",
]);

/** Maps an input[type=...] to its a11y role. */
function inputRole(type) {
  const t = String(type || "").toLowerCase();
  if (TEXTBOX_INPUT_TYPES.has(t)) return "textbox";
  if (t === "checkbox") return "checkbox";
  if (t === "radio") return "radio";
  if (t === "range") return "slider";
  if (t === "button" || t === "submit" || t === "reset") return "button";
  return "textbox";
}

/** A11y role for a distilled node, honouring an explicit role attribute. */
function roleOf(node) {
  const attrs = node.attrs || {};
  if (attrs.role) return String(attrs.role).toLowerCase();
  const tag = String(node.nodeName || "").toLowerCase();
  if (tag === "#document" || node.nodeType === 9) return "document";
  if (tag === "a") return "link";
  if (HEADING_TAGS.has(tag)) return "heading";
  if (tag === "button") return "button";
  if (tag === "select") return "combobox";
  if (tag === "option") return "option";
  if (tag === "textarea") return "textbox";
  if (tag === "input") return inputRole(attrs.type);
  if (tag === "img") return "img";
  return "generic";
}

/**
 * Interactive = one of the widget roles, or an explicit role=, or a tabindex,
 * or distilled click semantics (onclick/handlers). Only interactive elements
 * get a [ref=sN].
 */
function isInteractive(node, role) {
  if (INTERACTIVE_ROLES.has(role)) return true;
  const attrs = node.attrs || {};
  if (attrs.role !== undefined && attrs.role !== "") return true;
  if (attrs.tabindex !== undefined && attrs.tabindex !== null && attrs.tabindex !== "") return true;
  if (attrs.click) return true;
  return false;
}

/** Collapses whitespace and truncates; double quotes are escaped. */
function cleanName(raw) {
  const s = String(raw ?? "").replace(/\s+/g, " ").trim();
  const capped = s.length > 200 ? s.slice(0, 200) + "…" : s;
  return capped.replace(/"/g, '\\"');
}

/**
 * Roles whose a11y name comes from their content — including text nested in
 * descendant elements, not just direct #text children. Real pages (LinkedIn
 * especially) wrap link and heading text in spans, so direct-children-only
 * folding leaves every such name empty (live reading: `- link ""` under a
 * `- text "…"` child). Generic containers are deliberately NOT here: a div
 * named by its whole subtree would swallow the layout.
 */
const NAME_FROM_CONTENT = new Set([
  "link",
  "button",
  "heading",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "treeitem",
  "radio",
  "checkbox",
  "listitem",
  "cell",
  "row",
  "columnheader",
  "img",
]);

/**
 * Collects visible text from a node's subtree, img alt included, walking
 * breadth-first: direct text first, and deeper levels only as needed — no
 * assumptions about where the page put the text. Whitespace-collapsed and
 * capped so a huge subtree cannot blow up the name.
 */
function subtreeText(node, cap = 400) {
  let out = "";
  let level = (node.children || []).slice();
  while (level.length > 0 && out.length < cap) {
    const next = [];
    for (const c of level) {
      if (out.length >= cap) break;
      if (c.nodeType === 3) out += " " + String(c.attrs?.text ?? "");
      else if (String(c.nodeName).toLowerCase() === "img" && c.attrs?.alt) out += " " + c.attrs.alt;
      else for (const gc of c.children || []) next.push(gc);
    }
    level = next;
  }
  return out.replace(/\s+/g, " ").trim();
}

/** Direct #text children only — the pre-subtree behaviour, for generics. */
function ownTextOf(node) {
  return (node.children || [])
    .filter((c) => c.nodeType === 3)
    .map((c) => c.attrs?.text || "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Accessible name: aria-label, then alt for images, then a distilled computed
 * name, then placeholder / current value for inputs, then content text —
 * subtree text for name-from-content roles and interactive generics (comment
 * bodies, post text wrappers are clickable divs with the text one span down),
 * direct text otherwise.
 */
function accessibleName(node, role, interactive = false) {
  const attrs = node.attrs || {};
  const ariaLabel = attrs["aria-label"] ?? attrs.ariaLabel;
  if (ariaLabel) return cleanName(ariaLabel);
  if (role === "img" && attrs.alt) return cleanName(attrs.alt);
  if (attrs.name) return cleanName(attrs.name);
  if (attrs.placeholder) return cleanName(attrs.placeholder);
  if (attrs.value !== undefined && attrs.value !== null && String(attrs.value) !== "" &&
      String(node.nodeName).toLowerCase() === "input") {
    return cleanName(attrs.value);
  }
  if (attrs.text) return cleanName(attrs.text);
  const fromContent = NAME_FROM_CONTENT.has(role) || (role === "generic" && interactive);
  return cleanName(fromContent ? subtreeText(node) : ownTextOf(node));
}

/**
 * Builds the snapshot YAML and its ref map.
 *
 * @param {object} domNodeTree distilled DOM tree (see module doc)
 * @returns {{ yaml: string, refMap: Record<string, number> }}
 */
export function buildSnapshot(domNodeTree) {
  const refMap = {};
  let counter = 0;
  const lines = [];

  const render = (node, depth) => {
    if (!node || node.nodeType === 3) return; // text is folded into names
    const attrs = node.attrs || {};
    const role = roleOf(node);
    const interactive = isInteractive(node, role);

    // Transparent containers: no line of their own, children move up.
    if (role === "generic" && !interactive && !accessibleName(node, role)) {
      for (const child of node.children || []) render(child, depth);
      return;
    }

    const name = accessibleName(node, role, interactive);
    const parts = [];
    let label;
    if (role === "document") {
      label = `- document "${name}":`;
    } else if (role === "heading") {
      const level = Number(attrs.level) || Number(String(node.nodeName || "").slice(1)) || 1;
      parts.push(`level=${level}`);
      label = `- heading "${name}"`;
    } else if (role === "generic") {
      label = `- text "${name}"`;
    } else {
      label = `- ${role} "${name}"`;
    }
    if (interactive) {
      const ref = `s${++counter}`;
      refMap[ref] = node.nodeId;
      parts.push(`ref=${ref}`);
    }
    lines.push("  ".repeat(depth) + label + (parts.length ? ` [${parts.join(" ")}]` : ""));
    for (const child of node.children || []) render(child, depth + 1);
  };

  render(domNodeTree, 0);
  return { yaml: lines.join("\n"), refMap };
}
