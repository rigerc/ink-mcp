import { describe, expect, it } from "vite-plus/test";
import {
  createHeadlessTerminal,
  readTerminalScreen,
  writeTerminal,
} from "./headless-terminal.ts";

describe("headless terminal CommonJS interop", () => {
  it("loads the terminal and reconstructs cursor updates", async () => {
    const terminal = createHeadlessTerminal(40, 10);
    try {
      await writeTerminal(terminal, "First\r\nSecond");
      expect(readTerminalScreen(terminal)).toBe("First\nSecond");
      await writeTerminal(terminal, "\u001b[1A\rReplaced\u001b[K");
      expect(readTerminalScreen(terminal)).toBe("Replaced\nSecond");
    } finally {
      terminal.dispose();
    }
  });
});
