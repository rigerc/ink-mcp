import { afterEach, describe, expect, it } from "vite-plus/test";
import { execFileSync } from "node:child_process";
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

  if (previousExecution === undefined)
    delete process.env.INK_MCP_ALLOW_EXECUTION;
  else process.env.INK_MCP_ALLOW_EXECUTION = previousExecution;

  if (previousWorkspace === undefined)
    delete process.env.INK_MCP_WORKSPACE_ROOT;
  else process.env.INK_MCP_WORKSPACE_ROOT = previousWorkspace;
});

describe("PTY integration", () => {
  it.each(["stop", "stop-exited", "close", "reap"])(
    "%s terminates descendants after the PTY leader exits",
    async (action) => {
      if (process.platform === "win32") return;

      const childCode =
        "process.on('SIGTERM',()=>{});process.on('SIGHUP',()=>{});" +
        "setInterval(()=>{},1000);process.send('ready');";

      const id = launch(
        "const {spawn}=require('node:child_process');" +
          "const c=spawn(process.execPath,['-e'," +
          JSON.stringify(childCode) +
          "],{stdio:['ignore','ignore','ignore','ipc']});" +
          "c.on('message',()=>process.stdout.write('CHILD='+c.pid+'\\n'));" +
          "process.stdin.setRawMode(true);process.stdin.resume();" +
          "process.stdin.on('data',()=>process.exit(0));",
      );

      const ready = await registry.wait({
        runId: id,
        condition: "text_present",
        text: "CHILD=",
        timeoutMs: 5000,
      });

      const childPid = Number(/CHILD=(\d+)/.exec(ready.screen.text)?.[1]);

      expect(childPid).toBeGreaterThan(0);

      try {
        if (action !== "stop") {
          registry.keys(id, ["x"]);

          const exited = await registry.wait({
            runId: id,
            condition: "process_exit",
            timeoutMs: 5000,
          });

          expect(exited.matched).toBe(true);
        }

        if (action === "reap") {
          // Filling the registry evicts the exited leader on the fourth start.
          for (let index = 0; index < 4; index++) {
            launch("setInterval(()=>{},1000)");
          }

          expect(() => registry.status(id)).toThrow("Unknown runId");
        } else if (action === "close") registry.close();
        else expect((await registry.stop(id)).stopped).toBe(true);

        // An orphan may remain as a zombie until the host's init reaps it.
        // ps distinguishes that state from a surviving running process.
        await expect
          .poll(
            () => {
              try {
                const state = execFileSync(
                  "ps",
                  ["-o", "stat=", "-p", String(childPid)],
                  {
                    encoding: "utf8",
                    stdio: ["ignore", "pipe", "ignore"],
                  },
                ).trim();

                return state === "" || state.startsWith("Z");
              } catch (error) {
                if (
                  error instanceof Error &&
                  "status" in error &&
                  error.status === 1
                )
                  return true;

                throw error;
              }
            },
            { timeout: 3000 },
          )
          .toBe(true);
      } finally {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          // The descendant has already been reaped.
        }
      }
    },
  );

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
    const id = launch(
      "setTimeout(() => process.stdout.write('LATE'), 400);setTimeout(() => process.exit(0), 1400)",
    );

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

    expect(
      (
        await registry.wait({
          runId: id,
          condition: "text_present",
          text: "READY",
          timeoutMs: 5000,
        })
      ).matched,
    ).toBe(true);
    const result = await registry.stop(id);
    expect(result.stopped).toBe(true);
  });

  it("keeps output slices aligned to Unicode boundaries", async () => {
    const id = launch("process.stdout.write('😀'.repeat(40000));");
    expect(
      (
        await registry.wait({
          runId: id,
          condition: "process_exit",
          timeoutMs: 10000,
        })
      ).matched,
    ).toBe(true);
    const output = registry.output(id, 0, 17);
    expect(output.output.endsWith("😀")).toBe(true);
    expect(output.output.codePointAt(0)).toBe(0x1f600);
    expect(output.nextOffset).toBeGreaterThanOrEqual(output.offset);
  });
});
