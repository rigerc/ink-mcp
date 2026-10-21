import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  assertExecutablePath,
  childEnvironment,
  workspace,
} from "./registry.ts";

describe("execution environment", () => {
  it("does not inherit arbitrary parent variables", () => {
    const previousSecret = process.env.INK_MCP_TEST_SECRET;
    const previousNodeOptions = process.env.NODE_OPTIONS;
    process.env.INK_MCP_TEST_SECRET = "secret-marker";
    process.env.NODE_OPTIONS = "--trace-warnings";

    try {
      const env = childEnvironment({ INK_MCP_CUSTOM: "provided" });
      expect(env.INK_MCP_TEST_SECRET).toBeUndefined();
      expect(env.NODE_OPTIONS).toBeUndefined();
      expect(env.INK_MCP_CUSTOM).toBe("provided");
      expect(env.TERM).toBe("xterm-256color");
      expect(env.PATH).toBe(process.env.PATH);
    } finally {
      if (previousSecret === undefined) delete process.env.INK_MCP_TEST_SECRET;
      else process.env.INK_MCP_TEST_SECRET = previousSecret;

      if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previousNodeOptions;
    }
  });

  it("rejects dangerous overrides regardless of key case", () => {
    for (const key of [
      "PATH",
      "Path",
      "NODE_OPTIONS",
      "node_path",
      "LD_PRELOAD",
      "DYLD_INSERT_LIBRARIES",
    ]) {
      expect(() => childEnvironment({ [key]: "injected" })).toThrow(
        "Disallowed environment override",
      );
    }

    expect(() => childEnvironment({ "INVALID-NAME": "value" })).toThrow(
      "Invalid environment override",
    );
    expect(() => childEnvironment({ CUSTOM: "bad\0value" })).toThrow(
      "Invalid environment override",
    );
  });
});

describe("workspace selection", () => {
  it("permits in-root paths and rejects traversal or outside symlinks", () => {
    const parent = mkdtempSync(join(tmpdir(), "ink-mcp-path-"));
    const root = join(parent, "workspace");
    const outside = join(parent, "outside");
    const previousRoot = process.env.INK_MCP_WORKSPACE_ROOT;

    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(root, "run.js"), "");
    writeFileSync(join(outside, "run.js"), "");
    process.env.INK_MCP_WORKSPACE_ROOT = root;

    try {
      expect(workspace(".")).toBe(realpathSync(root));
      expect(() => workspace("../outside")).toThrow("outside INK_MCP_WORKSPACE_ROOT");
      expect(() => assertExecutablePath(root, "../outside/run.js")).toThrow(
        "Executable outside workspace",
      );
      expect(() => assertExecutablePath(root, "./run.js")).not.toThrow();
      expect(() => assertExecutablePath(root, "node")).not.toThrow();

      // Creating directory symlinks can require privileges on Windows.
      if (process.platform !== "win32") {
        symlinkSync(outside, join(root, "outside-link"), "dir");
        symlinkSync(join(outside, "run.js"), join(root, "run-link.js"));

        expect(() => workspace("outside-link")).toThrow(
          "outside INK_MCP_WORKSPACE_ROOT",
        );
        expect(() => assertExecutablePath(root, "./run-link.js")).toThrow(
          "Executable outside workspace",
        );
      }
    } finally {
      if (previousRoot === undefined) delete process.env.INK_MCP_WORKSPACE_ROOT;
      else process.env.INK_MCP_WORKSPACE_ROOT = previousRoot;
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
