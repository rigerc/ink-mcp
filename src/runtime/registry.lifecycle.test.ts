import { afterEach, describe, expect, it } from "vite-plus/test";
import { registry } from "./registry.ts";

const previousExecution = process.env.INK_MCP_ALLOW_EXECUTION;
const previousWorkspace = process.env.INK_MCP_WORKSPACE_ROOT;
const runs: string[] = [];

function enableExecution(): void {
  process.env.INK_MCP_ALLOW_EXECUTION = "1";
  process.env.INK_MCP_WORKSPACE_ROOT = process.cwd();
}

function launch(code: string): string {
  enableExecution();
  const started = registry.start({
    projectRoot: ".",
    executable: process.platform === "win32" ? "node.exe" : "node",
    args: ["-e", code],
  });
  runs.push(started.runId);

  return started.runId;
}

afterEach(async () => {
  for (const id of runs.splice(0)) {
    try {
      await registry.stop(id, true);
    } catch {
      // Already reaped after an exit.
    }
  }

  if (previousExecution === undefined) delete process.env.INK_MCP_ALLOW_EXECUTION;
  else process.env.INK_MCP_ALLOW_EXECUTION = previousExecution;

  if (previousWorkspace === undefined) delete process.env.INK_MCP_WORKSPACE_ROOT;
  else process.env.INK_MCP_WORKSPACE_ROOT = previousWorkspace;
});

describe("PTY integration", () => {
  it("handles input, revision-based waits, resize, and normal exit", async () => {
    const id = launch(
      "process.stdin.setRawMode(true);process.stdin.resume();" +
        "process.stdout.write('READY');" +
        "process.stdin.on('data', d => {" +
        "if (d.toString().includes('\\r')) {" +
        "process.stdout.write('SELECTED');process.exit(0);" +
        "} else if (d.toString().includes('\\x1b[B')) {" +
        "process.stdout.write('DOWN');}});",
    );
    const ready = await registry.wait({
      runId: id,
      condition: "text_present",
      text: "READY",
      timeoutMs: 5000,
    });
    expect(ready.matched).toBe(true);
    const initial = await registry.screen(id);
    expect(initial.revision).toBeGreaterThan(0);
    const sent = registry.keys(id, ["ArrowDown"]);
    const changed = await registry.wait({
      runId: id,
      condition: "screen_changed",
      sinceRevision: sent.revision,
      timeoutMs: 5000,
    });
    expect(changed.matched).toBe(true);
    expect(changed.screen.text).toContain("DOWN");
    const resized = await registry.resize(id, 100, 30);
    expect(resized.cols).toBe(100);
    expect(resized.revision).toBeGreaterThan(changed.screen.revision);
    registry.keys(id, ["Enter"]);
    const exited = await registry.wait({
      runId: id,
      condition: "process_exit",
      timeoutMs: 5000,
    });
    expect(exited.matched).toBe(true);
    expect(registry.status(id).exitCode).toBe(0);
    expect((await registry.stop(id)).stopped).toBe(true);
  });

  it("does not call a blank pre-render screen stable", async () => {
    const id = launch("setTimeout(() => process.stdout.write('LATE'), 400);setTimeout(() => process.exit(0), 1400)");
    const early = await registry.wait({
      runId: id,
      condition: "screen_stable",
      stableMs: 10,
      timeoutMs: 150,
    });
    expect(early.matched).toBe(false);
    const late = await registry.wait({
      runId: id,
      condition: "text_present",
      text: "LATE",
      timeoutMs: 2000,
    });
    expect(late.matched).toBe(true);
  });

  it("stops a child that ignores graceful termination", async () => {
    if (process.platform === "win32") return;
    const id = launch(
      "process.on('SIGTERM',()=>{});process.stdout.write('READY');setInterval(()=>{},100)",
    );
    expect((await registry.wait({
      runId: id,
      condition: "text_present",
      text: "READY",
      timeoutMs: 5000,
    })).matched).toBe(true);
    const result = await registry.stop(id);
    expect(result.stopped).toBe(true);
  });

  it("keeps output slices aligned to Unicode boundaries", async () => {
    const id = launch("process.stdout.write('😀'.repeat(40000));");
    expect((await registry.wait({
      runId: id,
      condition: "process_exit",
      timeoutMs: 10000,
    })).matched).toBe(true);
    const output = registry.output(id, 0, 17);
    expect(output.output.endsWith("😀")).toBe(true);
    expect(output.output.codePointAt(0)).toBe(0x1f600);
    expect(output.nextOffset).toBeGreaterThanOrEqual(output.offset);
  });
});
