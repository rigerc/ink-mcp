---
name: ink-development
description: Develop, operate, and test Ink terminal UI applications with the local stdio Ink Dev MCP server. Use when a coding agent needs to inspect Ink versions, run a CLI in a PTY, drive keyboard input, or debug terminal output.
---

# Ink development with MCP tools

Use `ink_project_check` to inspect the project and verify Ink/React compatibility before assuming APIs or entrypoints.
For bundled, version-independent guidance, read `references/ink-guidance.json` (resource URI: `skill://ink-development/references/ink-guidance.json`). Verify component APIs against the installed Ink version.

For interactive tests:
1. Call `ink_run_start` with a trusted executable and optionally `waitFor: {condition: "text_present", text: "..."}`. The response includes the run ID, screen and process status.
2. Call `ink_run_interact` with `keys` and/or `resize`. Prefer a `waitFor` condition (for example `screen_stable`) rather than arbitrary sleeps; inspect the returned screen.
3. Call `ink_run_observe` to read the screen and process status without mutating the CLI, or to wait for an exit. Set `output: {}` only when raw PTY output is needed for debugging.
4. Always call `ink_run_stop` to release resources.

The default server advertises five tools. Set `INK_MCP_TOOLSET=legacy` only for clients that still require the previous eleven-tool interface, including `ink_docs_search`.

Execution requires `INK_MCP_ALLOW_EXECUTION=1` and is limited to the selected server workspace for path validation. This is not a security sandbox: child processes run with the local user's permissions. Only execute trusted projects.
