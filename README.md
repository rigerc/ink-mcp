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

| Tool | Description |
|---|---|
| ink_project_inspect | Inspect package dependencies, scripts and Ink/React versions |
| ink_project_validate | Find missing dependencies and version compatibility issues |
| ink_docs_search | Query bundled Ink reference snippets; no network requests |
| ink_run_start | Start an Ink CLI with a real pseudoterminal |
| ink_run_screen | Inspect the current visible screen using xterm/headless |
| ink_run_keys | Send text, arrows, Enter, Escape, Tab, Backspace and Ctrl keys |
| ink_run_resize | Resize the PTY and screen emulator |
| ink_run_wait | Wait for text, screen change, stability or exit |
| ink_run_output | Retrieve bounded raw PTY output (combined stdout/stderr) |
| ink_run_status | Inspect process state and exit code |
| ink_run_stop | Terminate and clean up a run |

## Example development loop

1. Call ink_project_inspect with projectRoot ".".
2. Call ink_run_start with projectRoot ".", executable "node" and args ["dist/cli.js"].
3. Use ink_run_wait with condition "text_present" and the expected prompt.
4. Send keys with ink_run_keys (for example ["ArrowDown", "Enter"]).
5. Inspect the current screen with ink_run_screen, and verify the expected result.
6. Stop the process with ink_run_stop.

Run handles persist across MCP calls until explicitly stopped or until the server disconnects.
The screen snapshot is the current terminal viewport, not raw output with ANSI stripped.

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
- src/runtime/project.ts — project analysis and curated documentation
- src/skills.ts and skills/ — agent skill publishing
- scripts/smoke-stdio.mts — compiled entry-point integration test
