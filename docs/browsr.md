# Browsr — drive the real running Chrome, provider independent

Browsr is browser control for agents: it lets any MCP-capable provider
(Claude Code or anything else that speaks MCP) list tabs, snapshot a page's
DOM, click, type, read text, evaluate JavaScript, screenshot and read console
output — in the user's **real running Chrome**, with their logged-in sessions,
extensions and cookies.

- No `--remote-debugging-port`
- No headless Chrome, no Playwright
- No debugger API — DOM access is injected script, so no "started debugging
  this browser" banner can ever appear
- No vendor coupling — the MCP server is plain stdio MCP

## Architecture

```
provider (any MCP client)
    │ stdio MCP
browsr MCP server  (dist/index.js)
    │ WebSocket  ws://127.0.0.1:8757
native host  (src/host/host.mjs, spawned by Chrome)
    │ native messaging (4-byte length-prefixed JSON on stdin/stdout)
extension background service worker  (extension/)
    │ chrome.tabs  +  chrome.scripting (injected DOM functions)
the real running Chrome
```

The extension is the only part that touches Chrome. It uses `chrome.tabs` for
tab operations and `chrome.scripting` for DOM operations — functions injected
into the page (snapshot walks, clicks, typing), so there is no debugger
attachment and no banner. The native host bridges the extension's native
messaging port to a localhost WebSocket; the MCP server connects there. The
WebSocket server is hand-rolled (RFC 6455, text frames only) because Node's
global `WebSocket` is client-only and browsr adds no new runtime dependencies.

The wire protocol is one shape end to end: send `{id, command, ...params}`,
get `{id, ok, result}` or `{id, ok: false, error}`. Every command frame gets
a reply — a bad or unknown command fails loudly with `missing command key`
or `unknown command` instead of silence.

## Install

One-time setup, four steps:

1. **Build** (if not already done): `npm install && npm run build`

2. **Load the extension** — in Chrome open `chrome://extensions`, enable
   *Developer mode*, click *Load unpacked*, and select the repo's
   `extension/` directory. Copy the extension ID shown on its card
   (32 characters). Developer mode is required for unpacked extensions.

3. **Register host + MCP server** — from the repo root:

   ```sh
   node dist/cli.js install --extension-id <the-32-char-id>
   ```

   This writes `com.browsr.bridge.json` into Chrome's user-level
   `NativeMessagingHosts` directory (macOS default), pointing at
   `src/host/host.mjs` with `allowed_origins` locked to that one extension
   ID — the ID is stable per machine and must match, or Chrome refuses the
   connection. The same command registers the `browsr` MCP server in
   `~/.claude.json` (a `.bak-browsr` backup is written first).
   `--dest <dir>` redirects the manifest (tests), `--chrome-dir <dir>`
   targets a non-default Chrome profile root. `browsr uninstall` removes
   both registrations again.

4. **Restart Chrome**, then restart Claude Code.

   Chrome reads native messaging host manifests **only at startup** —
   reloading the extension is NOT enough; Chrome must fully quit and start
   again. Without the restart the extension loads but cannot reach the host,
   and every tool returns a not-connected error.

The extension and the host keep each other alive: the host pings the
extension every 20 s over the native port, which resets the MV3 service
worker's idle timer.

## Usage

Eleven tools, all named after what they do:

| Tool | What it does |
|------|--------------|
| `tabs_list` | List tabs: id, title, url, active |
| `tab_open {url, active?}` | Open a tab |
| `tab_select {tab}` | Bring a tab to the front |
| `tab_close {tab}` | Close a tab |
| `dom_snapshot {tab}` | A11y-tree YAML of the page, with `[ref=sN]` ids |
| `dom_click {tab, ref}` | Click an element (scrolls into view first) |
| `dom_type {tab, ref, text}` | Focus an element and type into it |
| `page_text {tab}` | Read `document.body.innerText` |
| `eval_js {tab, code}` | Evaluate JavaScript (awaits promises) |
| `tab_screenshot {tab}` | PNG screenshot of the visible tab, base64 |
| `console_logs {tab}` | Console output captured since the last snapshot |

### The ref workflow

DOM interaction goes through snapshot refs:

1. `dom_snapshot {tab: 42}` returns YAML like:

   ```
   - document "Example Domain":
     - heading "Example Domain" [level=1]
     - link "More information..." [ref=s1]
     - textbox "Search" [ref=s2]
     - button "Go" [ref=s3]
   ```

2. `dom_type {tab: 42, ref: "s2", text: "browsr bridge"}` fills the
   search box, `dom_click {tab: 42, ref: "s3"}` submits.

Refs are assigned per snapshot in DOM order (`s1, s2, …`). They stay valid
until the next `dom_snapshot` on that tab or a navigation; using a stale or
unknown ref returns `unknown ref sN — take a new snapshot`.

Clicks scroll the element into view first and fire the element's own click
(a dispatched pointer-event fallback covers custom elements); typing goes
through the native value setter plus `input`/`change` events, so framework
listeners see it, and contenteditable fields get `insertText` at the caret.
No coordinate-based input is synthesized — element-addressed clicks survive
virtualized-list reflow, coordinate clicks do not.

## Troubleshooting

- **"Browsr bridge not connected — start Chrome (with the Browsr extension
  loaded and its native host installed) and try again."** — Chrome is not
  running, the extension is not loaded, or the native host manifest is
  missing/stale (e.g. the repo moved; re-run install). The MCP server stays
  alive and reconnects on the next call, so fixing Chrome is enough — no
  restart needed. A fresh install also needs the Chrome restart from step 4.
- **No reply to a command** — every command frame answers, ok or a loud
  error (`missing command key`, `unknown command`, ...). If nothing comes
  back at all, the host log tells the story: `/tmp/browsr.log` (override
  with `BROWSR_LOG`). The extension reconnects to the host with backoff
  after a host death and respawns it from disk.
- **Big screenshots** — the native messaging channel caps message size; very
  large viewports can exceed it. Scroll or shrink the window and retry.
- **Port conflict** — the bridge uses `ws://127.0.0.1:8757`; override with
  `BROWSR_PORT` (picked up by both host and MCP server).
- **node < 22** — the MCP server needs the global `WebSocket` client; on
  older runtimes it exits with a clear message instead of crashing.

## Scope

macOS first (the installer's default Chrome directory). `--dest`/
`--chrome-dir` keep nothing blocked elsewhere, but Linux/Chrome and
Chromium/Edge install paths are not implemented yet.
