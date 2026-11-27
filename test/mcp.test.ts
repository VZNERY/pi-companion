import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertServers, serverNames } from "../extensions/companion/mcp.ts";

const dirWith = (config: unknown) => {
  const dir = mkdtempSync(join(tmpdir(), "agent-"));
  writeFileSync(join(dir, "mcp.json"), JSON.stringify(config));
  return dir;
};

test("server names are read from a nested or a flat mcp.json", () => {
  assert.deepEqual(serverNames(dirWith({ mcpServers: { memory: {}, video: {} } })), ["memory", "video"]);
  assert.deepEqual(serverNames(dirWith({ memory: {}, images: {} })), ["memory", "images"]);
});

test("a known server passes; an unknown one fails early and lists what is configured", () => {
  const dir = dirWith({ mcpServers: { memory: {}, video: {} } });
  assert.doesNotThrow(() => assertServers(["memory"], dir));
  assert.throws(() => assertServers(["nope", "memory"], dir), /unknown MCP server: nope \(configured: memory, video\)/);
});
