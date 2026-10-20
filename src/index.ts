#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { getConfig } from "./config.ts";
import { registerTools } from "./tools.ts";
import { getSkillsInstructions, registerSkills } from "./skills.ts";
import { registry } from "./runtime/registry.ts";

const config = getConfig();
const instructions = getSkillsInstructions();
const handle = serveStdio(() => {
  const server = new McpServer(
    { name: config.SERVER_NAME, version: config.SERVER_VERSION },
    instructions ? { instructions } : undefined,
  );
  registerTools(server);
  registerSkills(server);
  server.server.onclose = () => registry.close();
  return server;
}, {
  onerror: (error) => process.stderr.write("MCP protocol error: " + error.message + "\n"),
});

let closing = false;
const shutdown = () => {
  if (closing) return;
  closing = true;
  registry.close();
  void handle.close().then(() => process.exit(0)).catch((error: unknown) => {
    process.stderr.write("Shutdown error: " + String(error) + "\n");
    process.exit(1);
  });
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
