import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { Effect, Schema } from "effect";
import type { JsonObject } from "./lib/json.ts";
import { toMcpSchema } from "./lib/mcp-schema.ts";
import {
  createErrorResult,
  createTextResult,
  runMcpEffect,
} from "./lib/utils.ts";
import { registry } from "./runtime/registry.ts";
import {
  inspectProject,
  validateProject,
  searchDocs,
} from "./runtime/project.ts";

function execute(
  work: () => Promise<JsonObject> | JsonObject,
): Promise<CallToolResult> {
  return runMcpEffect(
    Effect.tryPromise({
      try: async () => work(),
      catch: (error) => error,
    }).pipe(
      Effect.map((value) => createTextResult(value)),
      Effect.catch((error) =>
        Effect.succeed(
          createErrorResult({
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
      ),
    ),
  );
}

const projectInput = toMcpSchema(Schema.Struct({ projectRoot: Schema.String }));
const runInput = toMcpSchema(Schema.Struct({ runId: Schema.String }));
const readonly = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false,
};
const mutating = { readOnlyHint: false, openWorldHint: false };

export function registerTools(server: McpServer): void {
  server.registerTool(
    "ink_project_inspect",
    {
      title: "Inspect Ink Project",
      description:
        "Inspect local package.json for Ink/React versions, package scripts and entrypoints without executing project code.",
      inputSchema: projectInput,
      annotations: readonly,
    },
    ({ projectRoot }) => execute(() => inspectProject(projectRoot)),
  );

  server.registerTool(
    "ink_project_validate",
    {
      title: "Validate Ink Project",
      description:
        "Check local Ink and React dependency compatibility and identify common project setup issues.",
      inputSchema: projectInput,
      annotations: readonly,
    },
    ({ projectRoot }) => execute(() => validateProject(projectRoot)),
  );

  server.registerTool(
    "ink_docs_search",
    {
      title: "Search Ink Guidance",
      description:
        "Search curated local reference snippets for Ink components and hooks. No network fetch is performed.",
      inputSchema: toMcpSchema(
        Schema.Struct({
          query: Schema.String,
          version: Schema.optional(Schema.String),
          limit: Schema.optional(Schema.Number),
        }),
      ),
      annotations: readonly,
    },
    ({ query, version, limit }) =>
      execute(() => searchDocs(query, version, limit)),
  );

  server.registerTool(
    "ink_run_start",
    {
      title: "Start Ink CLI",
      description:
        "Launch a CLI in a real PTY. Requires INK_MCP_ALLOW_EXECUTION=1; returns a persistent runId.",
      inputSchema: toMcpSchema(
        Schema.Struct({
          projectRoot: Schema.String,
          executable: Schema.String,
          args: Schema.optional(Schema.Array(Schema.String)),
          cols: Schema.optional(Schema.Number),
          rows: Schema.optional(Schema.Number),
          env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
        }),
      ),
      annotations: mutating,
    },
    ({ projectRoot, executable, args, cols, rows, env }) =>
      execute(() =>
        registry.start({
          projectRoot,
          executable,
          args: args ? [...args] : undefined,
          cols,
          rows,
          env,
        }),
      ),
  );

  server.registerTool(
    "ink_run_screen",
    {
      title: "Read Ink Screen",
      description:
        "Return the current PTY screen reconstructed by a headless terminal emulator.",
      inputSchema: runInput,
      annotations: readonly,
    },
    ({ runId }) => execute(() => registry.screen(runId)),
  );

  server.registerTool(
    "ink_run_keys",
    {
      title: "Send Terminal Keys",
      description:
        "Write text and special keys (Enter, Tab, arrows, Ctrl+C) to a running Ink CLI.",
      inputSchema: toMcpSchema(
        Schema.Struct({
          runId: Schema.String,
          keys: Schema.Array(Schema.String),
        }),
      ),
      annotations: mutating,
    },
    ({ runId, keys }) => execute(() => registry.keys(runId, [...keys])),
  );

  server.registerTool(
    "ink_run_resize",
    {
      title: "Resize Terminal",
      description:
        "Resize a running Ink PTY and its headless emulator to test responsive terminal layouts.",
      inputSchema: toMcpSchema(
        Schema.Struct({
          runId: Schema.String,
          cols: Schema.Number,
          rows: Schema.Number,
        }),
      ),
      annotations: mutating,
    },
    ({ runId, cols, rows }) =>
      execute(() => registry.resize(runId, cols, rows)),
  );

  server.registerTool(
    "ink_run_wait",
    {
      title: "Wait For Ink State",
      description:
        "Wait for visible text, screen changes, stable output or process exit, with a bounded timeout.",
      inputSchema: toMcpSchema(
        Schema.Struct({
          runId: Schema.String,
          condition: Schema.Literals([
            "text_present",
            "text_absent",
            "screen_changed",
            "screen_stable",
            "process_exit",
          ]),
          text: Schema.optional(Schema.String),
          since: Schema.optional(Schema.String),
          stableMs: Schema.optional(Schema.Number),
          timeoutMs: Schema.optional(Schema.Number),
        }),
      ),
      annotations: readonly,
    },
    (args) => execute(() => registry.wait(args)),
  );

  server.registerTool(
    "ink_run_output",
    {
      title: "Read Raw Terminal Output",
      description:
        "Read a bounded raw PTY output slice, with offset and truncation metadata.",
      inputSchema: toMcpSchema(
        Schema.Struct({
          runId: Schema.String,
          offset: Schema.optional(Schema.Number),
          limit: Schema.optional(Schema.Number),
        }),
      ),
      annotations: readonly,
    },
    ({ runId, offset, limit }) =>
      execute(() => registry.output(runId, offset, limit)),
  );

  server.registerTool(
    "ink_run_status",
    {
      title: "Process Status",
      description:
        "Read a managed Ink process status, exit code, and timestamps.",
      inputSchema: runInput,
      annotations: readonly,
    },
    ({ runId }) => execute(() => registry.status(runId)),
  );

  server.registerTool(
    "ink_run_stop",
    {
      title: "Stop Ink Process",
      description:
        "Terminate a managed Ink process and dispose its screen emulator.",
      inputSchema: toMcpSchema(
        Schema.Struct({
          runId: Schema.String,
          force: Schema.optional(Schema.Boolean),
        }),
      ),
      annotations: mutating,
    },
    ({ runId, force }) => execute(() => registry.stop(runId, force)),
  );
}
