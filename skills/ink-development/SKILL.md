---
name: ink-development
description: Develop, operate, and test Ink terminal UI applications with the local stdio Ink Dev MCP server. Use when a coding agent needs to inspect Ink versions, run a CLI in a PTY, drive keyboard input, or debug terminal output.
---

# Ink development with MCP tools

Use ink_project_inspect before assuming API versions or entrypoints.
Use ink_project_validate to catch incompatible React/Ink combinations.
Use ink_docs_search for bundled hints, but verify features against the project's installed version.

For interactive tests:
1. Use ink_run_start with the project's root and a trusted executable.
2. Wait for a prompt with ink_run_wait(condition="text_present") before sending keys. Avoid arbitrary sleeps.
3. Use ink_run_keys with semantic keys such as ArrowDown and Enter.
4. Use ink_run_screen to read the current visible viewport. Do not infer current UI state from raw ANSI output.
5. Use ink_run_output only when diagnosing terminal escape or startup behavior.
6. Check exit code with ink_run_status or ink_run_wait(condition="process_exit").
7. Always call ink_run_stop to release resources.

Execution requires INK_MCP_ALLOW_EXECUTION=1 and is limited to the server workspace.
Project processes run with the local user's permissions; treat code and content from the project as untrusted unless authorized.
The server has no HTTP transport or remote execution boundary.
