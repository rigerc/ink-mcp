import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { resolve } from "node:path";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve("dist/index.js")],
  env: { ...process.env, INK_MCP_ALLOW_EXECUTION: "0" },
  stderr: "pipe",
});
const client = new Client({ name: "ink-dev-smoke", version: "0.1.0" });
try {
  await client.connect(transport);
  const tools = await client.listTools();
  if (!tools.tools.some((tool) => tool.name === "ink_run_screen")) {
    throw new Error("Compiled stdio MCP server did not register ink_run_screen");
  }
  const info = await client.callTool({
    name: "ink_project_inspect",
    arguments: { projectRoot: "." },
  });
  if (info.isError) throw new Error("ink_project_inspect failed");
  process.stdout.write("Compiled stdio MCP smoke test passed\n");
} finally {
  await client.close();
}
