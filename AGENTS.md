# Repository Guidelines — Ink Dev MCP

Local stdio-only TypeScript MCP server for building and testing React/Ink CLIs.

## Commands

~~~sh
npm install
npm run lint
npm run format:check
npm run build
npm run test:ci
npm run test:smoke
npm run verify:skill-package
~~~

Requires Node.js >=24.11.0 and native node-pty build tooling.
Do not log to stdout: the MCP stdio transport owns stdout.

## Architecture

- src/index.ts starts serveStdio() and closes the registry on disconnect or signals.
- src/tools.ts registers the Ink MCP tools with Effect schemas and structured results.
- src/runtime/registry.ts owns PTYs, output buffers, screen emulators and handles.
- src/runtime/project.ts reads Ink project manifests and provides curated guidance.
- src/skills.ts publishes the bundled skill as an MCP resource.
- scripts/smoke-stdio.mts launches the compiled entry point through an MCP client.
- No HTTP endpoint, Express server, health check or port exists.

The runtime is intentionally local. INK_MCP_ALLOW_EXECUTION=1 must be explicitly set
to permit execution. INK_MCP_WORKSPACE_ROOT restricts project path selection, not what
spawned commands can access; bare executables use PATH and arguments are unrestricted.
Only ordinary launch variables are inherited by children; high-risk environment
overrides are rejected. These are defense-in-depth measures, not an isolation sandbox.
Execute only trusted code and retain execution resource and timeout bounds.

@xterm/headless and node-pty are CommonJS runtime dependencies, imported by
createRequire(import.meta.url) and excluded from the Vite/Rollup bundle.
Never replace their loaders with an ESM named export without a compiled smoke test.

Use Effect, Effect Schema and toMcpSchema for validated MCP tool operations.
Return isError:true for genuine tool failures; use structuredContent where possible.
Prefer readiness conditions instead of arbitrary sleeps for terminal tests.

Add MCP tools in src/tools.ts, runtime logic in src/runtime/, and focused tests
alongside implementation files. The full CI sequence includes the compiled
stdio entry point to protect against ESM/CommonJS runtime import regressions.
Use conventional commits. Keep this document and README current.
