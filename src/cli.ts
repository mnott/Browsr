#!/usr/bin/env node
/**
 * browsr CLI — install, uninstall and diagnose the browser bridge.
 *
 *   browsr install --extension-id <id>   write the native-host manifest,
 *                                        register the MCP server, print next steps
 *   browsr uninstall                     remove both registrations
 *   browsr status                        show what is registered and where
 *
 * The install target is the end user's machine: the Chrome user-level
 * NativeMessagingHosts directory for the host manifest, and the top-level
 * mcpServers object of ~/.claude.json (or any other MCP client's config) for
 * the server entry. Both writes are idempotent and backed up.
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const HOST_NAME = "com.browsr.bridge";
const MANIFEST_NAME = `${HOST_NAME}.json`;
const MCP_KEY = "browsr";
const BACKUP_SUFFIX = ".bak-browsr";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const hostPath = join(packageRoot, "src", "host", "host.mjs");
const serverEntry = join(packageRoot, "dist", "index.js");
const extensionDir = join(packageRoot, "extension");

const c = {
  ok: (s: string) => `\x1b[32m✓\x1b[0m ${s}`,
  bad: (s: string) => `\x1b[31m✗\x1b[0m ${s}`,
  warn: (s: string) => `\x1b[33m!\x1b[0m ${s}`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

/** Unpacked extension ids: 32 alphanumeric characters. */
export const EXTENSION_ID_RE = /^[a-zA-Z0-9]{32}$/;

// ---------------------------------------------------------------------------
// Native host manifest
// ---------------------------------------------------------------------------

/** macOS Chrome's user-level NativeMessagingHosts directory (testable). */
export function defaultManifestDir(home: string = homedir(), chromeDir?: string): string {
  const root = chromeDir ?? join(home, "Library", "Application Support", "Google", "Chrome");
  return join(root, "NativeMessagingHosts");
}

export interface HostManifest {
  name: string;
  description: string;
  path: string;
  type: "stdio";
  allowed_origins: string[];
}

export function buildHostManifest(extensionId: string, host: string = hostPath): HostManifest {
  return {
    name: HOST_NAME,
    description: "browsr — connects Chrome to the browsr MCP server",
    path: host,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
}

/** Writes (idempotently) the host manifest into `manifestDir`. */
export function writeHostManifest(
  manifestDir: string,
  manifest: HostManifest
): { path: string; changed: boolean } {
  if (!existsSync(manifest.path)) {
    throw new Error(`host script not found: ${manifest.path} — run npm run build / reinstall the package`);
  }
  mkdirSync(manifestDir, { recursive: true });
  chmodSync(manifest.path, 0o755); // the manifest runs host.mjs via its shebang
  const manifestPath = join(manifestDir, MANIFEST_NAME);
  const existing = existsSync(manifestPath)
    ? (() => {
        try {
          return JSON.parse(readFileSync(manifestPath, "utf8"));
        } catch {
          return null;
        }
      })()
    : null;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o644 });
  return { path: manifestPath, changed: JSON.stringify(existing) !== JSON.stringify(manifest) };
}

export function removeHostManifest(manifestDir: string): { path: string; removed: boolean } {
  const manifestPath = join(manifestDir, MANIFEST_NAME);
  if (!existsSync(manifestPath)) return { path: manifestPath, removed: false };
  rmSync(manifestPath);
  return { path: manifestPath, removed: true };
}

// ---------------------------------------------------------------------------
// MCP client registration (~/.claude.json and friends)
// ---------------------------------------------------------------------------

export function readClaudeConfig(path: string): Record<string, any> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e: any) {
    throw new Error(`${path} is not valid JSON (${e.message}). Fix or move it, then retry.`);
  }
}

/** Never writes without a backup — a malformed write would cost the user every MCP server they have. */
export function writeClaudeConfig(path: string, config: Record<string, any>): void {
  if (existsSync(path)) copyFileSync(path, path + BACKUP_SUFFIX);
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
}

export function mcpEntry(command: string = serverEntry): Record<string, unknown> {
  return {
    type: "stdio",
    command: "node",
    args: [command],
    description:
      "Browser control for agents: real Chrome tabs and DOM — snapshot, click, type, read, screenshot.",
  };
}

/** Registers (or updates) the browsr entry under top-level mcpServers. Mutates in place. */
export function applyMcpRegistration(
  config: Record<string, any>,
  entry: Record<string, unknown> = mcpEntry()
): { existed: boolean } {
  if (typeof config.mcpServers !== "object" || config.mcpServers === null) config.mcpServers = {};
  const existed = !!config.mcpServers[MCP_KEY];
  config.mcpServers[MCP_KEY] = entry;
  return { existed };
}

/** Removes only the browsr entry, leaving every other server untouched. Mutates in place. */
export function removeMcpRegistration(config: Record<string, any>): boolean {
  const servers = config.mcpServers;
  if (typeof servers !== "object" || servers === null || !(MCP_KEY in servers)) return false;
  delete servers[MCP_KEY];
  if (Object.keys(servers).length === 0) delete config.mcpServers;
  return true;
}

// ---------------------------------------------------------------------------
// Install / uninstall / status
// ---------------------------------------------------------------------------

/**
 * Everything the user must do outside this CLI after install. Chrome reads
 * native messaging host manifests ONLY at startup — reloading the extension is
 * not enough — so the restart note is a hard requirement, not a nicety.
 */
export const RESTART_CHROME_NOTE =
  "Restart Chrome — it reads native messaging host manifests only at startup.\n" +
  "  Reloading the extension is NOT enough; Chrome must fully quit and start again.";

export const EXTENSION_LOAD_STEPS = [
  "1. Open chrome://extensions in Chrome",
  "2. Enable Developer mode (top right)",
  "3. Click \"Load unpacked\" and select this folder:",
  `     ${extensionDir}`,
  "4. Copy the ID shown on the Browsr card (32 characters) — it is stable for",
  "   this machine and must match the allowed_origins in the host manifest",
  "5. Run:  browsr install --extension-id <that-id>",
].join("\n");

interface CliOptions {
  "extension-id"?: string;
  dest?: string;
  "chrome-dir"?: string;
  uninstall?: boolean;
}

function parseOptions(argv: string[]): CliOptions {
  const opts: CliOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--extension-id") opts["extension-id"] = argv[++i];
    else if (a === "--dest") opts.dest = argv[++i];
    else if (a === "--chrome-dir") opts["chrome-dir"] = argv[++i];
    else if (a === "--uninstall") opts.uninstall = true;
    else if (a === "--help" || a === "-h") (opts as any).help = true;
    else {
      process.stderr.write(`unknown option: ${a}\n\n`);
      (opts as any).help = true;
    }
  }
  return opts;
}

function manifestDirFor(opts: CliOptions): string {
  if (opts.dest !== undefined) {
    if (!isAbsolute(opts.dest)) fail("--dest needs an absolute directory path");
    return opts.dest;
  }
  return defaultManifestDir(undefined, opts["chrome-dir"]);
}

function fail(message: string): never {
  process.stderr.write(`browsr: ${message}\n`);
  process.exit(1);
}

function claudeJsonPath(): string {
  return join(homedir(), ".claude.json");
}

function install(opts: CliOptions): void {
  console.log(c.bold("Installing browsr"));
  console.log();

  // The registration stores absolute paths into this package. An npx cache is
  // not a stable home for that — clearing the cache would break the
  // registration silently, long after the install appeared to succeed.
  if (/[\\/](_npx|\.npm[\\/]_cacache)[\\/]/.test(packageRoot)) {
    console.log(c.bad("refusing to install from an npx cache directory."));
    console.log(c.dim(`  ${packageRoot}`));
    console.log();
    console.log("  browsr registers an absolute path to itself in the MCP client config, and this");
    console.log("  directory can be cleared at any time, which would break that silently.");
    console.log();
    console.log(c.bold("  Install locally instead:"));
    console.log("    git clone <browsr> && npm install && npm run build && browsr install …");
    process.exit(1);
  }

  if (!existsSync(serverEntry)) {
    fail(`dist/index.js is missing — run "npm run build" in ${packageRoot}`);
  }

  const extensionId = opts["extension-id"];
  if (extensionId === undefined) {
    console.log(c.bad("--extension-id is required."));
    console.log();
    console.log("Load the extension first, then re-run install with its ID:");
    console.log();
    console.log(EXTENSION_LOAD_STEPS);
    process.exit(1);
  }
  if (!EXTENSION_ID_RE.test(extensionId)) {
    fail(
      `--extension-id must be exactly 32 alphanumeric characters (got ${extensionId.length}: "${extensionId}")`
    );
  }

  // 1. Native host manifest
  const manifest = buildHostManifest(extensionId);
  const written = writeHostManifest(manifestDirFor(opts), manifest);
  console.log(
    c.ok(`${written.changed ? "wrote" : "unchanged"} ${written.path}`)
  );
  console.log(c.dim(`  host:           ${manifest.path}`));
  console.log(c.dim(`  allowed_origins: ${manifest.allowed_origins[0]}`));

  // 2. MCP registration
  const configPath = claudeJsonPath();
  const config = readClaudeConfig(configPath);
  const { existed } = applyMcpRegistration(config);
  writeClaudeConfig(configPath, config);
  console.log(
    c.ok(`${existed ? "updated" : "registered"} "${MCP_KEY}" in ${configPath}`)
  );
  console.log(c.dim(`  entry: node ${serverEntry}`));
  console.log(c.dim(`  backup: ${configPath}${BACKUP_SUFFIX}`));

  console.log();
  console.log(c.bold("Next steps:"));
  console.log();
  console.log(`  ${c.warn("1.")} Load the extension if you have not already:`);
  console.log(c.dim("\n     " + EXTENSION_LOAD_STEPS.split("\n").slice(0, 4).join("\n     ")));
  console.log(`  ${c.warn("2.")} ${RESTART_CHROME_NOTE.split("\n").join("\n     ")}`);
  console.log(`  ${c.warn("3.")} Restart Claude Code (or your MCP client) to pick up the tools.`);
  console.log();
  console.log(c.dim("  The extension and host keep each other alive: the host pings every 20s,"));
  console.log(c.dim("  which resets the extension service worker's idle timer."));
}

function uninstall(opts: CliOptions): void {
  console.log(c.bold("Uninstalling browsr"));
  console.log();

  const configPath = claudeJsonPath();
  const config = readClaudeConfig(configPath);
  const removedRegistration = removeMcpRegistration(config);
  if (removedRegistration) writeClaudeConfig(configPath, config);

  const manifestDir = manifestDirFor(opts);
  const { path: manifestPath, removed } = removeHostManifest(manifestDir);

  if (!removedRegistration && !removed) {
    console.log(c.warn("nothing registered — no changes made"));
    return;
  }
  console.log(
    removedRegistration
      ? c.ok(`removed "${MCP_KEY}" from ${configPath}`)
      : c.dim(`"${MCP_KEY}" was not registered in ${configPath}`)
  );
  console.log(
    removed
      ? c.ok(`removed ${manifestPath}`)
      : c.dim(`no host manifest at ${manifestPath}`)
  );
  console.log();
  console.log(`  ${RESTART_CHROME_NOTE}`);
  console.log(`  Restart Claude Code to drop the tools.`);
}

function status(opts: CliOptions): void {
  console.log(c.bold("browsr status"));
  console.log();
  console.log(c.dim(`package:   ${packageRoot}`));
  console.log(c.dim(`extension: ${extensionDir} ${existsSync(extensionDir) ? "(present)" : "(missing)"}`));
  console.log(c.dim(`host name: ${HOST_NAME}`));
  console.log(c.dim(`bridge:    ws://127.0.0.1:${process.env.BROWSR_PORT || 8757} (BROWSR_PORT overrides)`));

  const configPath = claudeJsonPath();
  const servers = (readClaudeConfig(configPath).mcpServers ?? {}) as Record<string, any>;
  const entry = servers[MCP_KEY];
  if (entry) {
    console.log(c.ok(`registered in ${configPath} -> ${(entry.args ?? []).join(" ")}`));
    const target = entry.args?.[0];
    if (target && !existsSync(target)) {
      console.log(c.bad(`  but that path does not exist — run "browsr install" again`));
    }
  } else {
    console.log(c.bad(`not registered — run "browsr install --extension-id <id>"`));
  }

  const manifestPath = join(manifestDirFor(opts), MANIFEST_NAME);
  if (existsSync(manifestPath)) {
    let manifest: any = null;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      /* unreadable — report presence only */
    }
    console.log(c.ok(`host manifest: ${manifestPath}`));
    if (manifest?.allowed_origins) {
      console.log(c.dim(`  allowed_origins: ${manifest.allowed_origins.join(", ")}`));
      const origin = String(manifest.allowed_origins[0] ?? "");
      const id = /chrome-extension:\/\/([a-zA-Z0-9]*)\//.exec(origin)?.[1];
      if (id !== undefined && !EXTENSION_ID_RE.test(id)) {
        console.log(c.warn("  the allowed origin does not look like a 32-char extension id"));
      }
    }
    if (manifest?.path && !existsSync(manifest.path)) {
      console.log(c.bad(`  but the host script is gone: ${manifest.path} — reinstall`));
    }
  } else {
    console.log(c.bad(`no host manifest at ${manifestPath} — run "browsr install --extension-id <id>"`));
  }

  const nodeOk = Number(process.versions.node.split(".")[0]) >= 22;
  console.log(
    nodeOk
      ? c.ok(`node ${process.versions.node} (>= 22: global WebSocket available)`)
      : c.bad(`node ${process.versions.node} — browsr needs node >= 22`)
  );
}

const HELP = `browsr — browser control for agents (real Chrome tabs and DOM, MCP)

Usage:
  browsr install --extension-id <id> [options]   write the native-host manifest and
                                                 register the MCP server
  browsr uninstall [options]                     remove both registrations
  browsr status [options]                        show what is registered and where

Options:
  --extension-id <id>   32-char unpacked-extension id (required for install)
  --dest <dir>          absolute directory for the host manifest (default:
                        Chrome's user-level NativeMessagingHosts)
  --chrome-dir <dir>    non-default Chrome profile root
  --uninstall           with install: same as running "browsr uninstall"
  -h, --help            this help

The MCP server itself is started by your MCP client, not by hand.

First run:
${EXTENSION_LOAD_STEPS}`;

const INSTALL_HELP = `browsr install — write the Chrome native-host manifest and register the MCP server

Usage:
  browsr install --extension-id <32-char-id> [--dest <dir>] [--chrome-dir <dir>]

What it does:
  1. Writes ${MANIFEST_NAME} into Chrome's user-level NativeMessagingHosts
     directory, pointing at the bundled host with allowed_origins locked to
     that one extension id.
  2. Registers "${MCP_KEY}" in ~/.claude.json (backup: .claude.json${BACKUP_SUFFIX}).
  3. Prints the remaining manual steps.

You need the extension id first:
${EXTENSION_LOAD_STEPS}

After install:
${RESTART_CHROME_NOTE}
Then restart Claude Code to pick up the tools.`;

function main(): void {
  const command = process.argv[2];
  const args = process.argv.slice(3);
  const opts = parseOptions(args.filter((a) => a !== command));

  try {
    switch (command) {
      case "install": {
        if ((opts as any).help) {
          console.log(INSTALL_HELP);
          break;
        }
        if (opts.uninstall) {
          uninstall(opts);
          break;
        }
        install(opts);
        break;
      }
      case "uninstall":
      case "remove":
        uninstall(opts);
        break;
      case "status":
        status(opts);
        break;
      case "--help":
      case "-h":
      case undefined:
        console.log(HELP);
        break;
      default:
        console.log(HELP);
        process.exit(1);
    }
  } catch (e: any) {
    console.error(c.bad(e.message));
    process.exit(1);
  }
}

// Run only when executed as a script, so the test suite can import the
// functions above without triggering the CLI dispatch.
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) main();
