import { createRequire } from "node:module";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";

// @xterm/headless exposes a CommonJS entry point. A named ESM import may
// typecheck and bundle successfully but fail when Node loads dist/index.js.
const require = createRequire(import.meta.url);
const headless = require("@xterm/headless") as {
  Terminal: typeof HeadlessTerminal;
};

export function createHeadlessTerminal(cols: number, rows: number) {
  return new headless.Terminal({ cols, rows, allowProposedApi: true });
}

export async function writeTerminal(
  terminal: HeadlessTerminal,
  data: string,
): Promise<void> {
  await new Promise<void>((resolve) => terminal.write(data, resolve));
}

export function readTerminalScreen(terminal: HeadlessTerminal): string {
  const lines: string[] = [];
  for (let row = 0; row < terminal.rows; row++) {
    const line = terminal.buffer.active.getLine(row);
    lines.push(line?.translateToString(true) ?? "");
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}
