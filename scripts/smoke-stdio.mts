import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { resolve } from "node:path";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve("dist/index.js")],
  stderr: "pipe",
});

const client = new Client({ name: "ink-dev-smoke", version: "0.1.0" });

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const expected = [
    "ink_project_check",
    "ink_run_interact",
    "ink_run_observe",
    "ink_run_start",
    "ink_run_stop",
  ];
  const names = tools.tools.map((tool) => tool.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error("Unexpected compact tool registration: " + names.join(", "));
  }

  const info = await client.callTool({
    name: "ink_project_check",
    arguments: { projectRoot: "." },
  });

  if (info.isError) throw new Error("ink_project_check failed");
  process.stdout.write("Compiled stdio MCP smoke test passed\n");
} finally {
  await client.close();
}
