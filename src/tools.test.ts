import { afterEach, describe, expect, it } from "vite-plus/test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { registerTools } from "./tools.ts";

let client: Client | undefined;
let server: McpServer | undefined;

async function connect() {
  server = new McpServer({ name: "ink-test", version: "0.1.0" });
  registerTools(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-client", version: "1.0.0" });
  await server.connect(b);
  await client.connect(a);
  return client;
}

afterEach(async () => {
  await client?.close();
  await server?.close();
  client = undefined;
  server = undefined;
});

describe("Ink development MCP tools", () => {
  it("advertises all eleven tools", async () => {
    const connected = await connect();
    const listed = await connected.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      "ink_docs_search",
      "ink_project_inspect",
      "ink_project_validate",
      "ink_run_keys",
      "ink_run_output",
      "ink_run_resize",
      "ink_run_screen",
      "ink_run_start",
      "ink_run_status",
      "ink_run_stop",
      "ink_run_wait",
    ]);
  });

  it("inspects local package manifests", async () => {
    const connected = await connect();
    const response = await connected.callTool({
      name: "ink_project_inspect",
      arguments: { projectRoot: "." },
    });
    expect(response.isError).toBeFalsy();
    expect(response.structuredContent).toMatchObject({ name: "ink-dev-mcp" });
  });

  it("returns matching curated Ink docs", async () => {
    const connected = await connect();
    const response = await connected.callTool({
      name: "ink_docs_search",
      arguments: { query: "useInput keyboard" },
    });
    expect(response.isError).toBeFalsy();
    expect(JSON.stringify(response.structuredContent)).toContain("useInput");
  });

  it("does not allow execution by default", async () => {
    const connected = await connect();
    const previous = process.env.INK_MCP_ALLOW_EXECUTION;
    delete process.env.INK_MCP_ALLOW_EXECUTION;
    try {
      const response = await connected.callTool({
        name: "ink_run_start",
        arguments: { projectRoot: ".", executable: "node", args: ["--version"] },
      });
      expect(response.isError).toBe(true);
      expect(JSON.stringify(response.structuredContent)).toContain("disabled");
    } finally {
      if (previous !== undefined) process.env.INK_MCP_ALLOW_EXECUTION = previous;
    }
  });

  it("rejects an unknown runtime handle", async () => {
    const connected = await connect();
    const response = await connected.callTool({
      name: "ink_run_screen",
      arguments: { runId: "missing" },
    });
    expect(response.isError).toBe(true);
  });
});
