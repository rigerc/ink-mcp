# Ink Dev MCP

Local **stdio-only** MCP server for inspecting, exercising and debugging React/Ink terminal applications.

## Install

Requires Node.js 24.11+ and a native build toolchain for node-pty (Python, make, C/C++ compiler).

~~~sh
npm install
npm run build
~~~

Configure your MCP client to spawn the server over stdio:

~~~json
{
  "mcpServers": {
    "ink-dev": {
      "command": "node",
      "args": ["/absolute/path/to/ink-mcp/dist/index.js"],
      "env": {
        "INK_MCP_WORKSPACE_ROOT": "/absolute/path/to/workspace",
        "INK_MCP_ALLOW_EXECUTION": "1"
      }
    }
  }
}
~~~

This is **not** an HTTP service. It does not listen on a port and must not print diagnostics to stdout.

## MCP tools

Five tools are advertised by default:

| Tool | Description |
|---|---|
| `ink_project_check` | Inspect dependencies, scripts, versions, and compatibility findings |
| `ink_run_start` | Start an Ink CLI in a PTY, optionally wait, and return its screen/status |
| `ink_run_interact` | Send keys and/or resize, optionally wait, and return the resulting screen/status |
| `ink_run_observe` | Read screen/status, optionally wait, or request bounded raw PTY output |
| `ink_run_stop` | Terminate and clean up a run |

`ink_project_check` returns `{ project, valid, findings }`. The three active session tools return a screen snapshot and process status; when `waitFor` is given, they also return `wait: { matched, elapsedMs }`. A timed-out wait returns `matched: false` rather than an MCP error. Wait conditions are `text_present`, `text_absent`, `screen_changed`, `screen_stable`, and `process_exit`. Conditions requiring a `text` value enforce it at runtime.

The read-only `ink_run_observe` can optionally return `output: { output, offset, nextOffset, truncatedBefore, runId }` when passed `output: { offset?, limit? }`. Raw output is omitted by default.

## Example development loop

1. Call `ink_project_check` with `projectRoot: "."`.
2. Call `ink_run_start` with `projectRoot: "."`, `executable: "node"`, `args: ["dist/cli.js"]`, and `waitFor: {condition: "text_present", text: "Select an option"}`.
3. Call `ink_run_interact` with `runId`, `keys: ["ArrowDown", "Enter"]`, and `waitFor: {condition: "screen_stable", stableMs: 300}`. Inspect `screen.text` and `wait.matched`.
4. Use `ink_run_observe` to inspect the screen or await `process_exit` without sending input.
5. Always stop the process with `ink_run_stop`.

Run handles persist across calls until explicitly stopped or until the server disconnects.
The screen snapshot is the current terminal viewport, not raw output with ANSI stripped.

## Legacy client compatibility and Ink guidance

The previous eleven-tool interface remains available with `INK_MCP_TOOLSET=legacy`, including `ink_project_inspect`, `ink_project_validate`, `ink_docs_search`, `ink_run_screen`, `ink_run_keys`, `ink_run_resize`, `ink_run_wait`, `ink_run_output`, and `ink_run_status`. This mode replaces, rather than augments, the compact tool list. The default is `INK_MCP_TOOLSET=compact`; other values are rejected at registration.

Curated Ink reference snippets now live in `skills/ink-development/references/ink-guidance.json`. Clients supporting MCP Skills or ordinary resources can load them from `skill://ink-development/references/ink-guidance.json`. Legacy `ink_docs_search` searches that same local resource; no network request is made.

## Local execution safety

PTY code execution is **disabled by default**. Set INK_MCP_ALLOW_EXECUTION=1 to enable it.
INK_MCP_WORKSPACE_ROOT defaults to the server working directory. It limits which project
directories can be selected and rejects path-style executables that resolve outside that
directory at validation time. This is a path-selection convenience, **not a security boundary**:
bare executable names (such as `node` or `bash`) resolve through PATH, and command arguments
are unrestricted. Even an executable inside the workspace can read or modify files elsewhere.

To reduce accidental credential exposure, spawned processes inherit only common launch
variables (for example PATH, HOME, temporary-directory settings, locale, and platform
settings), not the entire MCP server environment. Additional variables can be provided
through `ink_run_start.env`. Overrides of PATH, NODE_OPTIONS, NODE_PATH, LD_* and DYLD_*
are rejected (case-insensitively); TERM is fixed to xterm-256color. This filtering does
not prevent trusted code or unrestricted command arguments from accessing the host.

The server bounds retained processes, output history, terminal dimensions, user input and
waits. **Local code execution is not sandboxed.** Child processes run with the server user's
permissions, including access to files and credentials available to that user. Do not run
untrusted projects. For untrusted execution, use OS-level isolation with restricted mounts,
credentials and network access. Do not expose the stdio process through a network bridge
without separately designing isolation and authentication.

## ESM and CommonJS

The published @xterm/headless package has a CommonJS entry point that may fail when
imported with ESM named exports on Node 24. The runtime uses createRequire(import.meta.url)
to load it and node-pty, and Vite leaves both dependencies external.

## Development

~~~sh
npm run lint
npm run format:check
npm run build
npm run test:ci
npm run test:smoke
npm run verify:skill-package
~~~

The smoke test launches the **compiled** dist/index.js over MCP stdio and checks tool discovery.
This protects against type-check-passing but runtime-failing ESM import regressions.

Use MCP Inspector to exercise the server:

~~~sh
npx @modelcontextprotocol/inspector node ./dist/index.js
~~~

Documentation guidance is bundled and indicative. Verify API details against the exact
Ink version installed in the target project.

## Repo structure

- src/index.ts — stdio entry point
- src/tools.ts — MCP tool registration and validated schemas
- src/runtime/registry.ts — PTY lifecycle and headless terminal screen
- src/runtime/project.ts — project analysis and legacy guidance search
- skills/ink-development/references/ — published Ink guidance resource
- src/skills.ts and skills/ — agent skill publishing
- scripts/smoke-stdio.mts — compiled entry-point integration test
