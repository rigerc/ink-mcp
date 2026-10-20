import { Config as EffectConfig, ConfigProvider, Effect } from "effect";
import packageJson from "../package.json" with { type: "json" };

const configEffect = EffectConfig.all({
  NODE_ENV: EffectConfig.Literals(["development", "production", "test"], "NODE_ENV").pipe(
    EffectConfig.withDefault("development"),
  ),
  SERVER_NAME: EffectConfig.String("SERVER_NAME").pipe(
    EffectConfig.withDefault(packageJson.name),
  ),
  SERVER_VERSION: EffectConfig.String("SERVER_VERSION").pipe(
    EffectConfig.withDefault(packageJson.version),
  ),
  LOG_LEVEL: EffectConfig.Literals(["error", "warn", "info", "debug"], "LOG_LEVEL").pipe(
    EffectConfig.withDefault("info"),
  ),
});
export type Config = Effect.Success<typeof configEffect>;
const loadConfig = configEffect.parse(ConfigProvider.fromEnv());
let cached: Config | undefined;
export function getConfig(): Config {
  if (!cached) {
    try {
      cached = Effect.runSync(loadConfig);
    } catch (error) {
      process.stderr.write("Invalid environment configuration: " + String(error) + "\n");
      process.exit(1);
    }
  }
  return cached;
}
export function isProduction(): boolean {
  return getConfig().NODE_ENV === "production";
}
export function isDevelopment(): boolean {
  return getConfig().NODE_ENV === "development";
}
