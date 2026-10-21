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

describe("Compact Ink MCP tools", () => {
  it("advertises exactly five tools by default", async () => {
    const connected = await connect();
    const listed = await connected.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      "ink_project_check",
      "ink_run_interact",
      "ink_run_observe",
      "ink_run_start",
      "ink_run_stop",
    ]);
    const observe = listed.tools.find((tool) => tool.name === "ink_run_observe");
    expect(observe?.annotations?.readOnlyHint).toBe(true);
    const interact = listed.tools.find((tool) => tool.name === "ink_run_interact");
    expect(interact?.annotations?.readOnlyHint).toBe(false);
  });

  it("offers all eleven previous tools in legacy mode", async () => {
    const previous = process.env.INK_MCP_TOOLSET;
    process.env.INK_MCP_TOOLSET = "legacy";
    try {
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
      const docs = await connected.callTool({
        name: "ink_docs_search",
        arguments: { query: "useInput keyboard" },
      });
      expect(docs.isError).toBeFalsy();
      expect(JSON.stringify(docs.structuredContent)).toContain("useInput");
    } finally {
      if (previous === undefined) delete process.env.INK_MCP_TOOLSET;
      else process.env.INK_MCP_TOOLSET = previous;
    }
  });

  it("returns project inspection and validation together", async () => {
    const connected = await connect();
    const response = await connected.callTool({
      name: "ink_project_check",
      arguments: { projectRoot: "." },
    });
    expect(response.isError).toBeFalsy();
    expect(response.structuredContent).toMatchObject({
      valid: expect.any(Boolean),
      project: { name: "ink-dev-mcp" },
      findings: expect.any(Array),
    });
  });

  it("disables execution by default", async () => {
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

  it("rejects missing session handles and empty interactions", async () => {
    const connected = await connect();
    const invalid = await connected.callTool({
      name: "ink_run_observe",
      arguments: { runId: "missing" },
    });
    expect(invalid.isError).toBe(true);
    const noInput = await connected.callTool({
      name: "ink_run_interact",
      arguments: { runId: "missing" },
    });
    expect(noInput.isError).toBe(true);
    expect(JSON.stringify(noInput.structuredContent)).toContain("keys or resize");
  });

  it("starts, resizes, drives keys, waits, observes output and stops", async () => {
    const previous = process.env.INK_MCP_ALLOW_EXECUTION;
    process.env.INK_MCP_ALLOW_EXECUTION = "1";
    const connected = await connect();
    let runId: string | undefined;
    try {
      const program = "process.stdin.setRawMode(true);process.stdout.write('READY');process.stdin.on('data',c=>{const s=c.toString();if(s.includes('x'))process.stdout.write(String.fromCharCode(13,10)+'KEY:x');if(s.includes(String.fromCharCode(13)))process.exit(0);});";
      const started = await connected.callTool({
        name: "ink_run_start",
        arguments: {
          projectRoot: ".",
          executable: "node",
          args: ["-e", program],
          waitFor: { condition: "text_present", text: "READY", timeoutMs: 10000 },
        },
      });
      expect(started.isError).toBeFalsy();
      const data = started.structuredContent as Record<string, any>;
      runId = data.runId as string;
      expect(data.wait.matched).toBe(true);
      expect(data.screen.text).toContain("READY");

      const interacted = await connected.callTool({
        name: "ink_run_interact",
        arguments: {
          runId,
          keys: ["x"],
          resize: { cols: 64, rows: 20 },
          waitFor: { condition: "text_present", text: "KEY:x", timeoutMs: 5000 },
        },
      });
      expect(interacted.isError).toBeFalsy();
      const changed = interacted.structuredContent as Record<string, any>;
      expect(changed.wait.matched).toBe(true);
      expect(changed.screen.cols).toBe(64);
      expect(changed.screen.text).toContain("KEY:x");

      const observed = await connected.callTool({
        name: "ink_run_observe",
        arguments: { runId, output: { limit: 4096 } },
      });
      expect(observed.isError).toBeFalsy();
      const observation = observed.structuredContent as Record<string, any>;
      expect(observation.status.status).toBe("running");
      expect(observation.output.output).toContain("KEY:x");

      const exited = await connected.callTool({
        name: "ink_run_interact",
        arguments: {
          runId,
          keys: ["Enter"],
          waitFor: { condition: "process_exit", timeoutMs: 5000 },
        },
      });
      expect(exited.isError).toBeFalsy();
      const ended = exited.structuredContent as Record<string, any>;
      expect(ended.wait.matched).toBe(true);
      expect(ended.status.status).toBe("exited");
      expect(ended.status.exitCode).toBe(0);
    } finally {
      if (runId) {
        await connected.callTool({
          name: "ink_run_stop",
          arguments: { runId },
        });
      }
      if (previous === undefined) delete process.env.INK_MCP_ALLOW_EXECUTION;
      else process.env.INK_MCP_ALLOW_EXECUTION = previous;
    }
  });
});
