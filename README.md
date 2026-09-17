# Browsr — browser control for agents

Browsr lets any MCP-capable client (Claude Code or anything else that speaks
MCP) drive the user's **real running Chrome** — the one with their logged-in
sessions, cookies and extensions. It lists tabs, snapshots a page's DOM as an
accessibility tree, clicks, types, reads text, evaluates JavaScript,
screenshots and reads console output.

- Real Chrome, no `--remote-debugging-port`, nothing headless, no Playwright
- No debugger attachment — no "started debugging this browser" banner
- Provider independent — plain stdio MCP, no coupling to any one vendor
- The browser-domain sibling of [Clickr](https://www.npmjs.com/package/@tekmidian/clickr)
  (screen/native): **anything in a web page → Browsr; screen and native apps → Clickr**

```
MCP client ─stdio─ browsr MCP server ─ws://127.0.0.1:8757─ native host ─native messaging─ extension ─tabs+scripting─ Chrome
```

## Quick install

Requires node ≥ 22 (the MCP server uses the global WebSocket client).

```sh
git clone <this repo> && cd browsr
npm install
npm run build

# 1. Load the extension: chrome://extensions → Developer mode → Load unpacked
#    → select the extension/ folder → copy its 32-char ID
# 2. Register host manifest + MCP server:
node dist/cli.js install --extension-id <the-32-char-id>
# 3. Restart Chrome (native host manifests are read only at startup —
#    reloading the extension is NOT enough), then restart Claude Code
```

Full walkthrough and troubleshooting: [docs/browsr.md](docs/browsr.md).

## Tools

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

Take a `dom_snapshot` before clicking or typing: refs (`s1, s2, …`) are
assigned per snapshot in DOM order and stay valid until the next snapshot or
navigation. Browsing actuation is Browsr's job — there is no control gate in
v1; the operator asking you to browse is the authorization.

## CLI

```
browsr install --extension-id <id>   write the Chrome native-host manifest,
                                     register the MCP server, print next steps
browsr uninstall                     remove both registrations
browsr status                        show what is registered and where
```

Configuration: `BROWSR_PORT` overrides the bridge port (default 8757),
`BROWSR_LOG` overrides the host log (default `/tmp/browsr.log`).
