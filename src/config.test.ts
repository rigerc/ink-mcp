import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import packageJson from "../package.json" with { type: "json" };

const envKeys = [
  "NODE_ENV",
  "SERVER_NAME",
  "SERVER_VERSION",
  "LOG_LEVEL",
] as const;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function importConfig() {
  vi.resetModules();

  return import("./config.ts");
}

describe("configuration", () => {
  it("defaults the server name and version from package.json", async () => {
    for (const key of envKeys) {
      vi.stubEnv(key, undefined);
    }

    const { getConfig } = await importConfig();

    expect(getConfig()).toEqual({
      NODE_ENV: "development",
      SERVER_NAME: packageJson.name,
      SERVER_VERSION: packageJson.version,
      LOG_LEVEL: "info",
    });
  });

  it("loads and parses environment values", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("SERVER_NAME", "custom-server");
    vi.stubEnv("SERVER_VERSION", "2.0.0");
    vi.stubEnv("LOG_LEVEL", "debug");

    const { getConfig } = await importConfig();

    expect(getConfig()).toEqual({
      NODE_ENV: "test",
      SERVER_NAME: "custom-server",
      SERVER_VERSION: "2.0.0",
      LOG_LEVEL: "debug",
    });
  });

  it("reports production and development environments", async () => {
    vi.stubEnv("NODE_ENV", "production");

    const config = await importConfig();

    expect(config.isProduction()).toBe(true);
    expect(config.isDevelopment()).toBe(false);
  });

  it("exits when environment configuration is invalid", async () => {
    vi.stubEnv("NODE_ENV", "staging");
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });

    const { getConfig } = await importConfig();

    expect(() => getConfig()).toThrow("process.exit(1)");
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(process.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining("Invalid environment configuration"),
    );
  });
});
