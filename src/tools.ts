import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { Effect, Schema } from "effect";
import type { JsonObject } from "./lib/json.ts";
import { toMcpSchema } from "./lib/mcp-schema.ts";
import {
  createErrorResult,
  createTextResult,
  runMcpEffect,
} from "./lib/utils.ts";
import { registry, type WaitInput } from "./runtime/registry.ts";
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

function registerLegacyTools(server: McpServer): void {
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
        "Wait for visible text, screen revisions, stable rendered output or process exit. Pass sinceRevision from ink_run_keys or ink_run_screen to avoid missed transitions.",
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
          sinceRevision: Schema.optional(Schema.Number),
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
        "Stop a managed PTY with a bounded graceful/forceful termination sequence; return stopped:false if termination cannot be confirmed.",
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

// Compact default tool surface. The legacy eleven-tool interface remains
// opt-in for clients that have not migrated.
const waitForSchema = Schema.Struct({
  condition: Schema.Literals([
    "text_present",
    "text_absent",
    "screen_changed",
    "screen_stable",
    "process_exit",
  ]),
  text: Schema.optional(Schema.String),
  since: Schema.optional(Schema.String),
  sinceRevision: Schema.optional(Schema.Number),
  stableMs: Schema.optional(Schema.Number),
  timeoutMs: Schema.optional(Schema.Number),
});

const resizeSchema = Schema.Struct({
  cols: Schema.Number,
  rows: Schema.Number,
});

async function observeRun(
  runId: string,
  waitFor?: Omit<WaitInput, "runId">,
  output?: { offset?: number; limit?: number },
) {
  const waited = waitFor ? await registry.wait({ ...waitFor, runId }) : null;
  const screen = waited?.screen ?? (await registry.screen(runId));

  const result: JsonObject = {
    runId,
    screen,
    status: registry.status(runId),
  };

  if (waited) {
    result.wait = { matched: waited.matched, elapsedMs: waited.elapsedMs };
  }

  if (output)
    result.output = registry.output(runId, output.offset, output.limit);

  return result;
}

function registerCompactTools(server: McpServer): void {
  server.registerTool(
    "ink_project_check",
    {
      title: "Check Ink Project",
      description:
        "Inspect package scripts, entrypoints, Ink/React versions and dependency compatibility without running project code.",
      inputSchema: projectInput,
      annotations: readonly,
    },
    ({ projectRoot }) => execute(() => validateProject(projectRoot)),
  );

  server.registerTool(
    "ink_run_start",
    {
      title: "Start Ink CLI",
      description:
        "Launch a CLI in a PTY, optionally wait for its initial state and return the visible screen and process status. Requires INK_MCP_ALLOW_EXECUTION=1.",
      inputSchema: toMcpSchema(
        Schema.Struct({
          projectRoot: Schema.String,
          executable: Schema.String,
          args: Schema.optional(Schema.Array(Schema.String)),
          cols: Schema.optional(Schema.Number),
          rows: Schema.optional(Schema.Number),
          env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
          waitFor: Schema.optional(waitForSchema),
        }),
      ),
      annotations: mutating,
    },
    ({ projectRoot, executable, args, cols, rows, env, waitFor }) =>
      execute(async () => {
        const started = registry.start({
          projectRoot,
          executable,
          args: args ? [...args] : undefined,
          cols,
          rows,
          env,
        });

        try {
          return {
            ...started,
            ...(await observeRun(started.runId, waitFor)),
          };
        } catch (error) {
          await registry.stop(started.runId, true);
          throw error;
        }
      }),
  );

  server.registerTool(
    "ink_run_interact",
    {
      title: "Interact With Ink CLI",
      description:
        "Resize the PTY and/or send keyboard keys, optionally wait for a condition, then return the resulting visible screen and process status.",
      inputSchema: toMcpSchema(
        Schema.Struct({
          runId: Schema.String,
          keys: Schema.optional(Schema.Array(Schema.String)),
          resize: Schema.optional(resizeSchema),
          waitFor: Schema.optional(waitForSchema),
        }),
      ),
      annotations: mutating,
    },
    ({ runId, keys, resize, waitFor }) =>
      execute(async () => {
        if ((!keys || keys.length === 0) && !resize) {
          throw new Error("keys or resize is required");
        }

        // Revision waits must be anchored before sending input:
        // otherwise a fast render could occur before wait() begins.
        const sinceRevision =
          waitFor?.condition === "screen_changed" &&
          waitFor.since === undefined &&
          waitFor.sinceRevision === undefined
            ? (await registry.screen(runId)).revision
            : undefined;

        if (resize) await registry.resize(runId, resize.cols, resize.rows);

        if (keys?.length) registry.keys(runId, [...keys]);

        return observeRun(
          runId,
          waitFor && sinceRevision !== undefined
            ? { ...waitFor, sinceRevision }
            : waitFor,
        );
      }),
  );

  server.registerTool(
    "ink_run_observe",
    {
      title: "Observe Ink CLI",
      description:
        "Read the current visible terminal screen and process status, optionally wait for a condition or include a bounded raw PTY output slice.",
      inputSchema: toMcpSchema(
        Schema.Struct({
          runId: Schema.String,
          waitFor: Schema.optional(waitForSchema),
          output: Schema.optional(
            Schema.Struct({
              offset: Schema.optional(Schema.Number),
              limit: Schema.optional(Schema.Number),
            }),
          ),
        }),
      ),
      annotations: readonly,
    },
    ({ runId, waitFor, output }) =>
      execute(() => observeRun(runId, waitFor, output)),
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

export function registerTools(server: McpServer): void {
  const toolset = process.env.INK_MCP_TOOLSET ?? "compact";

  if (toolset === "legacy") return registerLegacyTools(server);

  if (toolset !== "compact") {
    throw new Error("INK_MCP_TOOLSET must be compact or legacy");
  }

  registerCompactTools(server);
}
