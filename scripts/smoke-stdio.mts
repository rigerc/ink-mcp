import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Schema } from "effect";

const decodeRun = Schema.decodeUnknownSync(
  Schema.Struct({
    runId: Schema.String,
    screen: Schema.Struct({ text: Schema.String }),
    wait: Schema.Struct({ matched: Schema.Boolean }),
  }),
  { onExcessProperty: "ignore" },
);

async function smoke(entryPoint: string): Promise<void> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entryPoint],
    env: {
      INK_MCP_ALLOW_EXECUTION: "1",
      INK_MCP_WORKSPACE_ROOT: process.cwd(),
      INK_MCP_TOOLSET: "compact",
    },
    stderr: "pipe",
  });

  const client = new Client({ name: "ink-dev-smoke", version: "0.1.0" });
  let runId: string | undefined;

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
      throw new Error(
        "Unexpected compact tool registration: " + names.join(", "),
      );
    }

    const info = await client.callTool({
      name: "ink_project_check",
      arguments: { projectRoot: "." },
    });

    if (info.isError) throw new Error("ink_project_check failed");

    const started = await client.callTool({
      name: "ink_run_start",
      arguments: {
        projectRoot: ".",
        executable: process.platform === "win32" ? "node.exe" : "node",
        args: [
          "-e",
          "process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write('READY');process.stdin.on('data',()=>{process.stdout.write('DONE');process.exit(0)});",
        ],
        waitFor: { condition: "text_present", text: "READY", timeoutMs: 5000 },
      },
    });

    if (started.isError)
      throw new Error("PTY start failed: " + JSON.stringify(started));

    const ready = decodeRun(started.structuredContent);
    runId = ready.runId;

    if (!ready.wait.matched || !ready.screen.text.includes("READY")) {
      throw new Error("Compiled PTY did not render READY");
    }

    const interacted = await client.callTool({
      name: "ink_run_interact",
      arguments: {
        runId,
        keys: ["x"],
        waitFor: { condition: "process_exit", timeoutMs: 5000 },
      },
    });

    const ended = decodeRun(interacted.structuredContent);

    if (
      interacted.isError ||
      !ended.wait.matched ||
      !ended.screen.text.includes("DONE")
    ) {
      throw new Error("Compiled PTY interaction failed");
    }

    const stopped = await client.callTool({
      name: "ink_run_stop",
      arguments: { runId },
    });

    if (stopped.isError) throw new Error("Compiled PTY cleanup failed");

    runId = undefined;
  } finally {
    try {
      if (runId)
        await client.callTool({
          name: "ink_run_stop",
          arguments: { runId, force: true },
        });
    } finally {
      await client.close();
    }
  }
}

await smoke(resolve("dist/index.js"));

// Exercise a compiled layout with optional skills omitted without changing
// the source checkout's bundled resources.
const withoutSkills = mkdtempSync(join(tmpdir(), "ink-mcp-no-skills-"));

try {
  mkdirSync(join(withoutSkills, "dist"));
  mkdirSync(join(withoutSkills, "skills"));
  cpSync(resolve("dist/index.js"), join(withoutSkills, "dist/index.js"));
  writeFileSync(join(withoutSkills, "package.json"), '{"type":"module"}');
  symlinkSync(
    resolve("node_modules"),
    join(withoutSkills, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await smoke(join(withoutSkills, "dist/index.js"));
} finally {
  rmSync(withoutSkills, { recursive: true, force: true });
}

process.stdout.write(
  "Compiled stdio MCP smoke tests passed with and without skills\n",
);
