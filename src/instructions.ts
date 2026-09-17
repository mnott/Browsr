/**
 * Everything an agent needs to operate browsr correctly.
 *
 * This is the single source of truth for agent-facing guidance, and it ships
 * inside the MCP server itself so it reaches every session automatically — no
 * skill to install, no README to have read. The README is for humans deciding
 * whether to use browsr and how to install it; it deliberately does not repeat
 * these rules.
 *
 * Per-tool detail lives in the individual tool descriptions instead of here,
 * because those are fetched on demand while this text is loaded in every
 * session.
 */
export const INSTRUCTIONS = `browsr drives the user's real running Chrome — the one with their logged-in sessions, cookies and extensions. It lists tabs, snapshots a page's DOM as an accessibility tree, clicks, types (append or overwrite), selects options in native dropdowns, sets checkboxes and radios, presses keys, reads text, evaluates JavaScript, screenshots and reads console output. Chrome must be running with the browsr extension loaded; when it is not, every tool returns a clear "start Chrome" error and the server reconnects on the next call, so fixing Chrome is enough.

## Routing: browsr or the screen tool?

Anything inside a web page belongs to browsr: tabs, page content, form fields, buttons, page JavaScript, page console. Anything on screen but not in a web page — native applications, system dialogs, the menu bar — belongs to the screen-control tool (a separate MCP for native UI). When both could do it, browsr wins: it addresses elements by ref instead of by pixel, so reflow, scrolling and window moves cannot misdirect a click.

## The ref workflow

DOM interaction goes through snapshot refs. Take dom_snapshot first: it returns a11y-tree YAML in which every interactive element carries a [ref=sN] id. Pass that ref to dom_click, dom_type, dom_select_option, dom_set_checked or dom_press; dom_select_option accepts the <select>'s ref or any of its option refs. The snapshot shows live state — checkboxes and radios carry checked=true/false (radios also their group= name), options carry value= and selected=, textboxes carry value= with the text currently in the field — so you can pick the right element and verify states after acting. Never guess a ref, and never reuse a ref across snapshots: refs are assigned fresh, in DOM order, on every dom_snapshot, and stay valid only until the next snapshot or a navigation on that tab. An error like "unknown ref s5 — take a new snapshot" means exactly what it says: snapshot again and use the refs that one returns.

Typical loop: tabs_list to find the tab, dom_snapshot, dom_type into a field (mode "replace" to overwrite instead of append), dom_select_option for a native <select>, dom_set_checked for checkboxes and radios (radios cannot be unchecked — pick a sibling), dom_press for keys, then page_text or a fresh dom_snapshot to verify what actually happened. Synthesized key events never trigger browser default actions — no native submit-on-Enter, caret movement or shortcut activation — so dom_press reports which path fired for Enter ("requestSubmit" means the form fallback submitted, "keys" means only the events went out); when you need a real default action, prefer dom_click on the page's own button. A click that returns ok tells you the element was clicked, not what the page did with it — verify after acting.

## Waiting

Never busy-wait. There are exactly two sanctioned ways to wait: hand the work to a background task that notifies on completion, or make one blocking call that returns when the thing is done. No sleep loops, no polling, no manual retry loops — if you are tempted to poll, either verify once after the operation finishes or read the state when you actually need it.

## Actuation

browsr has no control gate: browsing actuation is its job, and the operator asking you to browse the web is the authorization. Clicks and typing happen in the user's real browser, visibly, acting with the user's own logged-in credentials — treat that with the care it deserves: read before you write, prefer narrow actions over broad ones, and never submit anything the user did not ask for.`;
