import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The names of the MCP servers Pi is configured with (the keys of mcp.json, flat or under "mcpServers"). */
export function serverNames(agentDir: string): string[] {
  const raw = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8")) as Record<string, unknown>;
  const servers = typeof raw.mcpServers === "object" && raw.mcpServers !== null ? (raw.mcpServers as Record<string, unknown>) : raw;
  return Object.keys(servers);
}

/** Fails early, with the configured names, when a job asks for a server that does not exist. */
export function assertServers(wanted: string[], agentDir: string): void {
  const known = serverNames(agentDir);
  const unknown = [...new Set(wanted)].filter((name) => !known.includes(name));
  if (unknown.length) throw new Error(`unknown MCP server${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")} (configured: ${known.join(", ")})`);
}
