/**
 * Tests for the browsr CLI's install machinery. Everything writes into
 * per-test temp directories — the real Chrome NativeMessagingHosts dir and
 * the real MCP client config are never touched by the suite.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXTENSION_ID_RE,
  HOST_NAME,
  buildHostManifest,
  writeHostManifest,
  removeHostManifest,
  defaultManifestDir,
  readClaudeConfig,
  writeClaudeConfig,
  applyMcpRegistration,
  removeMcpRegistration,
  mcpEntry,
  RESTART_CHROME_NOTE,
  EXTENSION_LOAD_STEPS,
} from "./cli.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "browsr-cli-test-"));
});

// A stand-in for the real host.mjs so writeHostManifest's existence check passes.
function fakeHost(): string {
  const p = join(tmp, "host.mjs");
  writeFileSync(p, "#!/usr/bin/env node\n");
  return p;
}

describe("extension id validation", () => {
  it("accepts exactly 32 alphanumeric characters", () => {
    expect(EXTENSION_ID_RE.test("abcdefghijklmnopqrstuvwxyz012345")).toBe(true);
    expect(EXTENSION_ID_RE.test("ABCDEF0123456789abcdef0123456789")).toBe(true);
  });

  it("rejects short, long, and non-alphanumeric ids", () => {
    expect(EXTENSION_ID_RE.test("abc")).toBe(false);
    expect(EXTENSION_ID_RE.test("a".repeat(33))).toBe(false);
    expect(EXTENSION_ID_RE.test("x".repeat(31) + "-!")).toBe(false);
  });
});

describe("native host manifest", () => {
  it("builds the manifest locked to one extension origin", () => {
    const m = buildHostManifest("abcdefghijklmnopqrstuvwxyz012345", "/x/host.mjs");
    expect(m).toEqual({
      name: HOST_NAME,
      description: expect.any(String),
      path: "/x/host.mjs",
      type: "stdio",
      allowed_origins: ["chrome-extension://abcdefghijklmnopqrstuvwxyz012345/"],
    });
  });

  it("writes the manifest into the dest dir and is idempotent", () => {
    const host = fakeHost();
    const dest = join(tmp, "NativeMessagingHosts");
    const m = buildHostManifest("abcdefghijklmnopqrstuvwxyz012345", host);

    const first = writeHostManifest(dest, m);
    expect(first.changed).toBe(true);
    expect(existsSync(first.path)).toBe(true);
    expect(JSON.parse(readFileSync(first.path, "utf8"))).toEqual(m);
    expect(first.path).toBe(join(dest, `${HOST_NAME}.json`));

    const second = writeHostManifest(dest, m);
    expect(second.changed).toBe(false); // same content, no rewrite noise

    // A different extension id changes the manifest.
    const third = writeHostManifest(dest, buildHostManifest("0123456789abcdef0123456789abcdef", host));
    expect(third.changed).toBe(true);
  });

  it("refuses to write a manifest pointing at a missing host", () => {
    const m = buildHostManifest("abcdefghijklmnopqrstuvwxyz012345", join(tmp, "missing.mjs"));
    expect(() => writeHostManifest(join(tmp, "dest"), m)).toThrow(/host script not found/);
  });

  it("removes the manifest and tolerates a missing one", () => {
    const dest = join(tmp, "NativeMessagingHosts");
    writeHostManifest(dest, buildHostManifest("abcdefghijklmnopqrstuvwxyz012345", fakeHost()));
    expect(removeHostManifest(dest)).toEqual({ path: join(dest, `${HOST_NAME}.json`), removed: true });
    expect(removeHostManifest(dest)).toEqual({ path: join(dest, `${HOST_NAME}.json`), removed: false });
  });

  it("defaults to Chrome's user-level NativeMessagingHosts directory", () => {
    expect(defaultManifestDir("/home/u")).toBe(
      join("/home/u", "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts")
    );
    expect(defaultManifestDir("/home/u", "/opt/chrome-root")).toBe(join("/opt/chrome-root", "NativeMessagingHosts"));
  });
});

describe("MCP client registration", () => {
  it("registers under top-level mcpServers and preserves other servers", () => {
    const config: Record<string, any> = { mcpServers: { other: { command: "x" } } };
    const { existed } = applyMcpRegistration(config, mcpEntry("/pkg/dist/index.js"));
    expect(existed).toBe(false);
    expect(config.mcpServers.browsr).toMatchObject({
      type: "stdio",
      command: "node",
      args: ["/pkg/dist/index.js"],
    });
    expect(config.mcpServers.other).toEqual({ command: "x" }); // untouched
  });

  it("creates mcpServers when absent and reports updates", () => {
    const config: Record<string, any> = {};
    applyMcpRegistration(config);
    expect(config.mcpServers.browsr).toBeDefined();
    expect(applyMcpRegistration(config).existed).toBe(true);
  });

  it("writeClaudeConfig backs up before writing", () => {
    const path = join(tmp, "config.json");
    writeFileSync(path, JSON.stringify({ mcpServers: { keep: { command: "k" } } }), "utf8");
    const config = readClaudeConfig(path);
    applyMcpRegistration(config, mcpEntry("/pkg/dist/index.js"));
    writeClaudeConfig(path, config);

    expect(existsSync(path + ".bak-browsr")).toBe(true);
    const after = readClaudeConfig(path);
    expect(after.mcpServers.keep).toEqual({ command: "k" });
    expect(after.mcpServers.browsr.args[0]).toBe("/pkg/dist/index.js");
  });

  it("readClaudeConfig reports invalid JSON loudly instead of clobbering", () => {
    const path = join(tmp, "config.json");
    writeFileSync(path, "{not json", "utf8");
    expect(() => readClaudeConfig(path)).toThrow(/not valid JSON/);
  });

  it("removeMcpRegistration removes only the browsr entry, and drops empty mcpServers", () => {
    const config: Record<string, any> = { mcpServers: { browsr: mcpEntry(), other: { command: "x" } } };
    expect(removeMcpRegistration(config)).toBe(true);
    expect(config.mcpServers).toEqual({ other: { command: "x" } });
    expect(removeMcpRegistration(config)).toBe(false); // already gone

    const lone: Record<string, any> = { mcpServers: { browsr: mcpEntry() } };
    removeMcpRegistration(lone);
    expect(lone.mcpServers).toBeUndefined(); // no empty husk left behind
  });
});

describe("install messaging contract", () => {
  it("tells the user to restart Chrome — manifests are read only at startup", () => {
    expect(RESTART_CHROME_NOTE).toMatch(/Restart Chrome/);
    expect(RESTART_CHROME_NOTE).toMatch(/only at startup/i);
    expect(RESTART_CHROME_NOTE).toMatch(/NOT enough/i); // extension reload is not enough
  });

  it("extension steps mention Developer mode, unpacked load, and the stable id", () => {
    expect(EXTENSION_LOAD_STEPS).toMatch(/chrome:\/\/extensions/);
    expect(EXTENSION_LOAD_STEPS).toMatch(/Developer mode/);
    expect(EXTENSION_LOAD_STEPS).toMatch(/Load unpacked/);
    expect(EXTENSION_LOAD_STEPS).toMatch(/extension/);
    expect(EXTENSION_LOAD_STEPS).toMatch(/32 characters/);
    expect(EXTENSION_LOAD_STEPS).toMatch(/allowed_origins/);
  });
});
