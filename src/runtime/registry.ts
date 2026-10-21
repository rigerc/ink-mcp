import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { IPty, spawn as spawnPty } from "node-pty";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";

const require = createRequire(import.meta.url);

// Both packages expose CommonJS entry points under Node.js. Never bundle them
// or import Terminal as an ESM named export in the production entry point.
// SAFETY: node-pty publishes spawn as a CommonJS property with its declared signature.
const { spawn } = require("node-pty") as { spawn: typeof spawnPty };

// SAFETY: @xterm/headless exposes Terminal as a CommonJS property.
const { Terminal } = require("@xterm/headless") as {
  Terminal: typeof HeadlessTerminal;
};

const MAX_PROCESSES = 4;
const MAX_OUTPUT = 1024 * 1024;
const MAX_INPUT_LENGTH = 8192;
const MAX_WAIT_MS = 30000;
const MAX_PENDING_CHARS = 256 * 1024;
const RESUME_PENDING_CHARS = 64 * 1024;
const EXIT_GRACE_MS = 1200;
const EXIT_FORCE_MS = 1200;
const RETAIN_EXITED_MS = 5 * 60 * 1000;

type Exit = { exitCode: number; signal?: number };

type Condition =
  | "text_present"
  | "text_absent"
  | "screen_changed"
  | "screen_stable"
  | "process_exit";

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
  sinceRevision?: number;
  stableMs?: number;
  timeoutMs?: number;
};

type RenderWaiter = { target: number; resolve: () => void };

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
  chunks: string[];
  queuedChars: number;
  writing: boolean;
  paused: boolean;
  disposed: boolean;
  receivedChunks: number;
  renderedChunks: number;
  revision: number;
  lastRenderedAt?: number;
  renderWaiters: RenderWaiter[];
  exitPromise: Promise<void>;
  resolveExit: () => void;
};

function within(root: string, path: string): boolean {
  const rel = relative(root, path);

  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel))
  );
}

export function workspace(projectRoot: string): string {
  const root = realpathSync(
    resolve(process.env.INK_MCP_WORKSPACE_ROOT ?? process.cwd()),
  );

  const target = realpathSync(resolve(root, projectRoot));

  if (!within(root, target)) {
    throw new Error("Project path is outside INK_MCP_WORKSPACE_ROOT");
  }

  return target;
}

function boundedSize(
  value: number | undefined,
  fallback: number,
  max: number,
): number {
  const actual = value ?? fallback;

  if (!Number.isInteger(actual) || actual < 1 || actual > max) {
    throw new Error("Terminal dimension out of range (1-" + max + ")");
  }

  return actual;
}

function requireExecution(): void {
  if (process.env.INK_MCP_ALLOW_EXECUTION !== "1") {
    throw new Error(
      "PTY execution disabled. Set INK_MCP_ALLOW_EXECUTION=1 to enable local code execution.",
    );
  }
}

// Forward only ordinary process-launch settings. Secrets and application-specific
// environment variables must be supplied explicitly by the caller.
const INHERITED_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "CI",
  "NODE_ENV",
]);

export function childEnvironment(
  overrides: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && INHERITED_ENV_KEYS.has(key.toUpperCase())) {
      env[key] = value;
    }
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) || value.includes("\0")) {
      throw new Error("Invalid environment override");
    }

    const upper = key.toUpperCase();

    if (
      upper === "PATH" ||
      upper === "NODE_OPTIONS" ||
      upper === "NODE_PATH" ||
      upper.startsWith("LD_") ||
      upper.startsWith("DYLD_")
    ) {
      throw new Error("Disallowed environment override: " + key);
    }

    env[key] = value;
  }

  env.TERM = "xterm-256color";

  return env;
}

// This validates path-style executables only. Bare names resolve through PATH;
// neither restriction confines the process after it starts.
export function assertExecutablePath(root: string, executable: string): void {
  if (!executable || executable.includes("\0")) {
    throw new Error("Invalid executable");
  }

  if (executable.includes("/") || executable.includes("\\")) {
    const target = realpathSync(resolve(root, executable));

    if (!within(root, target)) {
      throw new Error("Executable outside workspace");
    }
  }
}

function encodeKey(key: string): string {
  const keys = {
    Enter: "\r",
    Tab: "\t",
    Escape: "\x1b",
    Backspace: "\x7f",
    ArrowUp: "\x1b[A",
    ArrowDown: "\x1b[B",
    ArrowRight: "\x1b[C",
    ArrowLeft: "\x1b[D",
    Home: "\x1b[H",
    End: "\x1b[F",
    Delete: "\x1b[3~",
    PageUp: "\x1b[5~",
    PageDown: "\x1b[6~",
    "Ctrl+C": "\x03",
    "Ctrl+D": "\x04",
    "Ctrl+Z": "\x1a",
    "Ctrl+L": "\x0c",
    "Ctrl+U": "\x15",
  };

  const known = Object.entries(keys).find(([name]) => name === key)?.[1];

  if (known !== undefined) return known;

  if (key.length === 1) return key;
  throw new Error("Unsupported key: " + key);
}

// Offsets are UTF-16 code units for backward-compatible string slicing.
// Never return or drop half a surrogate pair.
function validOutputBoundary(text: string, boundary: number): number {
  if (boundary <= 0 || boundary >= text.length) return boundary;
  const prev = text.charCodeAt(boundary - 1);
  const next = text.charCodeAt(boundary);

  return prev >= 0xd800 && prev <= 0xdbff &&
      next >= 0xdc00 && next <= 0xdfff
    ? boundary + 1
    : boundary;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function terminatePty(run: Run, force: boolean): void {
  if (process.platform === "win32") {
    if (force) {
      try {
        // /T targets descendants; numeric PID is passed as an argument, not a shell.
        execFileSync("taskkill", ["/PID", String(run.pty.pid), "/T", "/F"], {
          stdio: "ignore",
          timeout: EXIT_FORCE_MS,
          windowsHide: true,
        });

        return;
      } catch {
        // It may have exited while taskkill was starting.
      }
    }

    // node-pty on Windows rejects signal arguments.
    run.pty.kill();

    return;
  }

  try {
    // forkpty starts a new session/process group. Signal the group so shell
    // scripts and their children receive the same termination request.
    process.kill(-run.pty.pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    // Fall back to the direct PTY child if the group is unavailable.
    run.pty.kill(force ? "SIGKILL" : "SIGTERM");
  }
}

export class RunRegistry {
  private readonly runs = new Map<string, Run>();

  private get(runId: string): Run {
    const run = this.runs.get(runId);

    if (!run) throw new Error("Unknown runId: " + runId);

    return run;
  }

  private release(run: Run): void {
    if (run.disposed) return;
    run.disposed = true;
    run.chunks.length = 0;
    run.terminal.dispose();
    for (const waiter of run.renderWaiters) waiter.resolve();
    run.renderWaiters.length = 0;
    this.runs.delete(run.id);
  }

  private reapExited(): void {
    const now = Date.now();

    for (const run of this.runs.values()) {
      if (
        run.endedAt !== undefined &&
        (now - run.endedAt >= RETAIN_EXITED_MS ||
          this.runs.size >= MAX_PROCESSES)
      ) {
        this.release(run);
      }
    }
  }

  private awaitRendered(run: Run, target = run.receivedChunks): Promise<void> {
    if (run.disposed || run.renderedChunks >= target) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      run.renderWaiters.push({ target, resolve });
    });
  }

  private flush(run: Run): void {
    if (run.disposed) return;
    const next = run.chunks.shift();

    if (next === undefined) {
      run.writing = false;

      return;
    }

    run.writing = true;
    run.terminal.write(next, () => {
      if (run.disposed) return;
      run.queuedChars -= next.length;
      run.renderedChunks++;
      run.revision++;
      run.lastRenderedAt = Date.now();

      if (run.paused && run.queuedChars <= RESUME_PENDING_CHARS) {
        run.paused = false;
        run.pty.resume();
      }

      for (let i = run.renderWaiters.length - 1; i >= 0; i--) {
        const waiter = run.renderWaiters[i];

        if (waiter && waiter.target <= run.renderedChunks) {
          run.renderWaiters.splice(i, 1);
          waiter.resolve();
        }
      }

      this.flush(run);
    });
  }

  start(input: StartInput) {
    requireExecution();
    const root = workspace(input.projectRoot);
    this.reapExited();

    if (this.runs.size >= MAX_PROCESSES) {
      throw new Error(
        "Maximum of " + MAX_PROCESSES + " active/retained runs reached",
      );
    }

    const cols = boundedSize(input.cols, 80, 500);
    const rows = boundedSize(input.rows, 24, 200);
    assertExecutablePath(root, input.executable);

    const args = input.args ?? [];

    if (
      args.length > 100 ||
      args.some((arg) => arg.length > MAX_INPUT_LENGTH || arg.includes("\0"))
    ) {
      throw new Error("Invalid executable arguments");
    }

    const env = childEnvironment(input.env);
    const terminal = new Terminal({
      cols,
      rows,
      allowProposedApi: false,
      scrollback: 2000,
    });

    let pty: IPty;

    try {
      pty = spawn(input.executable, args, {
        cwd: root,
        cols,
        rows,
        name: env.TERM,
        env,
      });
    } catch (error) {
      terminal.dispose();
      throw error;
    }

    const id = randomUUID();
    let resolveExit = () => {};
    const exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const run: Run = {
      id,
      pty,
      terminal,
      root,
      startedAt: Date.now(),
      output: "",
      outputBase: 0,
      chunks: [],
      queuedChars: 0,
      writing: false,
      paused: false,
      disposed: false,
      receivedChunks: 0,
      renderedChunks: 0,
      revision: 0,
      renderWaiters: [],
      exitPromise,
      resolveExit,
    };

    this.runs.set(id, run);
    pty.onData((data) => {
      if (run.disposed) return;
      run.output += data;

      if (run.output.length > MAX_OUTPUT) {
        const drop = validOutputBoundary(
          run.output,
          run.output.length - MAX_OUTPUT,
        );
        run.output = run.output.slice(drop);
        run.outputBase += drop;
      }

      run.chunks.push(data);
      run.queuedChars += data.length;
      run.receivedChunks++;

      if (!run.paused && run.queuedChars >= MAX_PENDING_CHARS) {
        run.paused = true;
        run.pty.pause();
      }

      if (!run.writing) this.flush(run);
    });
    pty.onExit((event) => {
      run.exit = { exitCode: event.exitCode, signal: event.signal };
      run.endedAt = Date.now();
      run.resolveExit();
    });

    return {
      runId: id,
      pid: pty.pid,
      cols,
      rows,
      status: "running",
      revision: run.revision,
      projectRoot: root,
    };
  }

  async screen(runId: string) {
    const run = this.get(runId);
    await this.awaitRendered(run);
    const buffer = run.terminal.buffer.active;
    const lines: string[] = [];

    for (let y = 0; y < run.terminal.rows; y++) {
      lines.push(
        buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? "",
      );
    }

    return {
      runId,
      text: lines.join("\n").trimEnd(),
      lines,
      cols: run.terminal.cols,
      rows: run.terminal.rows,
      cursor: { x: buffer.cursorX, y: buffer.cursorY },
      revision: run.revision,
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
    // Capture before writing to avoid missing the first response frame.
    const revision = run.revision;
    run.pty.write(data);

    return { runId, keysSent: keys.length, revision, status: "running" };
  }

  async resize(runId: string, cols: number, rows: number) {
    const run = this.get(runId);
    const width = boundedSize(cols, 80, 500);
    const height = boundedSize(rows, 24, 200);
    await this.awaitRendered(run);
    run.terminal.resize(width, height);
    run.revision++;
    run.lastRenderedAt = Date.now();

    if (!run.exit) run.pty.resize(width, height);

    return { runId, cols: width, rows: height, revision: run.revision };
  }

  status(runId: string) {
    const run = this.get(runId);

    return {
      runId,
      pid: run.pty.pid,
      projectRoot: run.root,
      status: run.exit ? "exited" : "running",
      revision: run.revision,
      exitCode: run.exit?.exitCode ?? null,
      signal: run.exit?.signal ?? null,
      startedAt: new Date(run.startedAt).toISOString(),
      endedAt: run.endedAt ? new Date(run.endedAt).toISOString() : null,
    };
  }

  output(runId: string, offset?: number, limit?: number) {
    const run = this.get(runId);

    if (
      (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) ||
      (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))
    ) {
      throw new Error("Invalid output offset or limit");
    }

    const requested = Math.max(run.outputBase, offset ?? run.outputBase);
    const start = validOutputBoundary(
      run.output,
      Math.min(run.output.length, requested - run.outputBase),
    );
    const count = Math.min(32768, limit ?? 8192);
    const end = validOutputBoundary(
      run.output,
      Math.min(run.output.length, start + count),
    );
    const data = run.output.slice(start, end);

    return {
      runId,
      output: data,
      offset: run.outputBase + start,
      nextOffset: run.outputBase + end,
      truncatedBefore: run.outputBase,
    };
  }

  async wait(input: WaitInput) {
    const run = this.get(input.runId);
    const timeout = Math.min(MAX_WAIT_MS, Math.max(1, input.timeoutMs ?? 5000));

    if (
      (input.condition === "text_present" ||
        input.condition === "text_absent") &&
      !input.text
    ) {
      throw new Error("text is required for this condition");
    }

    if (
      input.sinceRevision !== undefined &&
      (!Number.isSafeInteger(input.sinceRevision) || input.sinceRevision < 0)
    ) {
      throw new Error("sinceRevision must be a nonnegative integer");
    }

    const start = Date.now();
    const initialFrame = await this.screen(input.runId);
    const initialText = input.since ?? initialFrame.text;
    const initialRevision = input.sinceRevision ?? initialFrame.revision;

    while (Date.now() - start <= timeout) {
      const frame = await this.screen(input.runId);
      const stableMs = Math.max(0, input.stableMs ?? 300);

      const changed =
        input.sinceRevision !== undefined
          ? frame.revision > input.sinceRevision
          : input.since !== undefined
            ? frame.text !== initialText
            : frame.revision > initialRevision;

      const matched =
        (input.condition === "text_present" &&
          frame.text.includes(input.text ?? "")) ||
        (input.condition === "text_absent" &&
          !frame.text.includes(input.text ?? "")) ||
        (input.condition === "screen_changed" && changed) ||
        (input.condition === "screen_stable" &&
          run.lastRenderedAt !== undefined &&
          run.renderedChunks === run.receivedChunks &&
          Date.now() - run.lastRenderedAt >= stableMs) ||
        (input.condition === "process_exit" && !!run.exit);

      if (matched) {
        return { matched: true, elapsedMs: Date.now() - start, screen: frame };
      }

      await delay(50);
    }

    return {
      matched: false,
      elapsedMs: Date.now() - start,
      screen: await this.screen(input.runId),
    };
  }

  async stop(runId: string, force = false) {
    const run = this.get(runId);

    if (!run.exit) {
      try {
        terminatePty(run, force);
      } catch (error) {
        if (!run.exit) throw error;
      }

      if (!force) {
        await Promise.race([run.exitPromise, delay(EXIT_GRACE_MS)]);

        if (!run.exit) {
          try {
            terminatePty(run, true);
          } catch (error) {
            if (!run.exit) throw error;
          }
        }
      }

      if (!run.exit) {
        await Promise.race([run.exitPromise, delay(EXIT_FORCE_MS)]);
      }
    }

    if (!run.exit) {
      // Keep the handle: callers can retry forceful termination.
      return { runId, stopped: false, status: "running" };
    }

    await this.awaitRendered(run);
    this.release(run);

    return { runId, stopped: true, status: "exited" };
  }

  close(): void {
    for (const run of this.runs.values()) {
      if (!run.exit) {
        try {
          terminatePty(run, true);
        } catch {
          // Continue terminating other processes during shutdown.
        }
      }

      this.release(run);
    }
  }
}

export const registry = new RunRegistry();
