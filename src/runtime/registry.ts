import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { IPty } from "node-pty";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";

const require = createRequire(import.meta.url);
// Both packages expose CommonJS entry points under Node.js. Never bundle them
// or import Terminal as an ESM named export in the production entry point.
const { spawn } = require("node-pty") as typeof import("node-pty");
const { Terminal } = require("@xterm/headless") as {
  Terminal: typeof HeadlessTerminal;
};

const MAX_PROCESSES = 4;
const MAX_OUTPUT = 1024 * 1024;
const MAX_INPUT_LENGTH = 8192;
const MAX_WAIT_MS = 30000;

type Exit = { exitCode: number; signal?: number };
type Condition = "text_present" | "text_absent" | "screen_changed" | "screen_stable" | "process_exit";

export type StartInput = {
  projectRoot: string;
  executable: string;
  args?: string[];
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
};

export type WaitInput = {
  runId: string;
  condition: Condition;
  text?: string;
  since?: string;
  stableMs?: number;
  timeoutMs?: number;
};

type Run = {
  id: string;
  pty: IPty;
  terminal: HeadlessTerminal;
  root: string;
  startedAt: number;
  endedAt?: number;
  exit?: Exit;
  output: string;
  outputBase: number;
  pending: Promise<void>;
  updatedAt: number;
};

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}

export function workspace(projectRoot: string): string {
  const root = realpathSync(resolve(process.env.INK_MCP_WORKSPACE_ROOT ?? process.cwd()));
  const target = realpathSync(resolve(root, projectRoot));
  if (!within(root, target)) {
    throw new Error("Project path is outside INK_MCP_WORKSPACE_ROOT");
  }
  return target;
}

function boundedSize(value: number | undefined, fallback: number, max: number): number {
  const actual = value ?? fallback;
  if (!Number.isInteger(actual) || actual < 1 || actual > max) {
    throw new Error("Terminal dimension out of range (1-" + max + ")");
  }
  return actual;
}

function requireExecution(): void {
  if (process.env.INK_MCP_ALLOW_EXECUTION !== "1") {
    throw new Error("PTY execution disabled. Set INK_MCP_ALLOW_EXECUTION=1 to enable local code execution.");
  }
}

function encodeKey(key: string): string {
  const keys: Record<string, string> = {
    Enter: "\r", Tab: "\t", Escape: "\x1b", Backspace: "\x7f",
    ArrowUp: "\x1b[A", ArrowDown: "\x1b[B",
    ArrowRight: "\x1b[C", ArrowLeft: "\x1b[D",
    Home: "\x1b[H", End: "\x1b[F", Delete: "\x1b[3~",
    PageUp: "\x1b[5~", PageDown: "\x1b[6~",
    "Ctrl+C": "\x03", "Ctrl+D": "\x04", "Ctrl+Z": "\x1a",
    "Ctrl+L": "\x0c", "Ctrl+U": "\x15",
  };
  if (Object.hasOwn(keys, key)) return keys[key] ?? "";
  if (key.length === 1) return key;
  throw new Error("Unsupported key: " + key);
}

export class RunRegistry {
  private readonly runs = new Map<string, Run>();

  private get(runId: string): Run {
    const run = this.runs.get(runId);
    if (!run) throw new Error("Unknown runId: " + runId);
    return run;
  }

  start(input: StartInput) {
    requireExecution();
    const root = workspace(input.projectRoot);
    if (this.runs.size >= MAX_PROCESSES) {
      throw new Error("Maximum of " + MAX_PROCESSES + " retained runs reached; stop existing runs");
    }
    const cols = boundedSize(input.cols, 80, 500);
    const rows = boundedSize(input.rows, 24, 200);
    if (!input.executable || input.executable.includes("\0")) {
      throw new Error("Invalid executable");
    }
    if (input.executable.includes("/") || input.executable.includes("\\")) {
      const target = realpathSync(resolve(root, input.executable));
      if (!within(root, target)) throw new Error("Executable outside workspace");
    }
    const args = input.args ?? [];
    if (args.length > 100 || args.some((arg) => arg.length > MAX_INPUT_LENGTH || arg.includes("\0"))) {
      throw new Error("Invalid executable arguments");
    }
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    for (const [key, value] of Object.entries(input.env ?? {})) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) || /[\0]/.test(value)) {
        throw new Error("Invalid environment override");
      }
      env[key] = value;
    }
    env.TERM = "xterm-256color";
    const terminal = new Terminal({ cols, rows, allowProposedApi: false, scrollback: 2000 });
    let pty: IPty;
    try {
      pty = spawn(input.executable, args, { cwd: root, cols, rows, name: env.TERM, env });
    } catch (error) {
      terminal.dispose();
      throw error;
    }
    const id = randomUUID();
    const run: Run = {
      id, pty, terminal, root, startedAt: Date.now(),
      output: "", outputBase: 0, pending: Promise.resolve(), updatedAt: Date.now(),
    };
    this.runs.set(id, run);
    pty.onData((data) => {
      run.output += data;
      if (run.output.length > MAX_OUTPUT) {
        const drop = run.output.length - MAX_OUTPUT;
        run.output = run.output.slice(drop);
        run.outputBase += drop;
      }
      run.updatedAt = Date.now();
      run.pending = run.pending.then(() => new Promise<void>((done) => {
        terminal.write(data, done);
      }));
    });
    pty.onExit((event) => {
      run.exit = { exitCode: event.exitCode, signal: event.signal };
      run.endedAt = Date.now();
      run.updatedAt = Date.now();
    });
    return { runId: id, pid: pty.pid, cols, rows, status: "running", projectRoot: root };
  }

  async screen(runId: string) {
    const run = this.get(runId);
    await run.pending;
    const buffer = run.terminal.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < run.terminal.rows; y++) {
      lines.push(buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? "");
    }
    return {
      runId, text: lines.join("\n").trimEnd(), lines,
      cols: run.terminal.cols, rows: run.terminal.rows,
      cursor: { x: buffer.cursorX, y: buffer.cursorY },
      status: run.exit ? "exited" : "running",
      exitCode: run.exit?.exitCode ?? null,
    };
  }

  keys(runId: string, keys: string[]) {
    const run = this.get(runId);
    if (run.exit) throw new Error("Process has already exited");
    if (keys.length > 100) throw new Error("Too many keys");
    const data = keys.map(encodeKey).join("");
    if (data.length > MAX_INPUT_LENGTH) throw new Error("Input too large");
    run.pty.write(data);
    return { runId, keysSent: keys.length, status: "running" };
  }

  async resize(runId: string, cols: number, rows: number) {
    const run = this.get(runId);
    const width = boundedSize(cols, 80, 500);
    const height = boundedSize(rows, 24, 200);
    await run.pending;
    run.terminal.resize(width, height);
    if (!run.exit) run.pty.resize(width, height);
    return { runId, cols: width, rows: height };
  }

  status(runId: string) {
    const run = this.get(runId);
    return {
      runId, pid: run.pty.pid, projectRoot: run.root,
      status: run.exit ? "exited" : "running",
      exitCode: run.exit?.exitCode ?? null,
      signal: run.exit?.signal ?? null,
      startedAt: new Date(run.startedAt).toISOString(),
      endedAt: run.endedAt ? new Date(run.endedAt).toISOString() : null,
    };
  }

  output(runId: string, offset?: number, limit?: number) {
    const run = this.get(runId);
    const start = Math.max(run.outputBase, offset ?? run.outputBase);
    const count = Math.min(32768, Math.max(1, limit ?? 8192));
    const data = run.output.slice(start - run.outputBase, start - run.outputBase + count);
    return { runId, output: data, offset: start, nextOffset: start + data.length, truncatedBefore: run.outputBase };
  }

  async wait(input: WaitInput) {
    const run = this.get(input.runId);
    const timeout = Math.min(MAX_WAIT_MS, Math.max(1, input.timeoutMs ?? 5000));
    if ((input.condition === "text_present" || input.condition === "text_absent") && !input.text) {
      throw new Error("text is required for this condition");
    }
    const start = Date.now();
    const initial = input.since ?? (await this.screen(input.runId)).text;
    while (Date.now() - start <= timeout) {
      const frame = await this.screen(input.runId);
      const stableMs = Math.max(0, input.stableMs ?? 300);
      const matched =
        (input.condition === "text_present" && frame.text.includes(input.text ?? "")) ||
        (input.condition === "text_absent" && !frame.text.includes(input.text ?? "")) ||
        (input.condition === "screen_changed" && frame.text !== initial) ||
        (input.condition === "screen_stable" && Date.now() - run.updatedAt >= stableMs) ||
        (input.condition === "process_exit" && !!run.exit);
      if (matched) return { matched: true, elapsedMs: Date.now() - start, screen: frame };
      await new Promise<void>((done) => setTimeout(done, 50));
    }
    return { matched: false, elapsedMs: Date.now() - start, screen: await this.screen(input.runId) };
  }

  stop(runId: string, force = false) {
    const run = this.get(runId);
    if (!run.exit) run.pty.kill(force ? "SIGKILL" : "SIGTERM");
    this.runs.delete(runId);
    run.terminal.dispose();
    return { runId, stopped: true };
  }

  close(): void {
    for (const id of this.runs.keys()) {
      try {
        this.stop(id, true);
      } catch {
        // Continue releasing the remaining processes.
      }
    }
  }
}

export const registry = new RunRegistry();
