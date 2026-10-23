import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { workspace } from "./registry.ts";

type PackageManifest = {
  name?: string;
  type?: string;
  bin?: string | Record<string, string>;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

function readManifest(root: string): PackageManifest {
  const path = join(root, "package.json");

  if (!existsSync(path))
    throw new Error("No package.json found in project directory");

  // SAFETY: package.json is an untrusted manifest; optional fields are checked before use.
  return JSON.parse(readFileSync(path, "utf8")) as PackageManifest;
}

export function inspectProject(projectRoot: string) {
  const root = workspace(projectRoot);
  const manifest = readManifest(root);

  const dependencies = {
    ...manifest.peerDependencies,
    ...manifest.devDependencies,
    ...manifest.dependencies,
  };

  const installed = (name: string): string | null => {
    const path = join(root, "node_modules", name, "package.json");

    if (!existsSync(path)) return null;

    try {
      // SAFETY: package version is optional and only used for diagnostics.
      return (
        (JSON.parse(readFileSync(path, "utf8")) as { version?: string })
          .version ?? null
      );
    } catch {
      return null;
    }
  };

  const lockfile =
    [
      "pnpm-lock.yaml",
      "yarn.lock",
      "package-lock.json",
      "bun.lock",
      "bun.lockb",
    ].find((file) => existsSync(join(root, file))) ?? null;

  return {
    projectRoot: root,
    name: manifest.name ?? null,
    moduleType: manifest.type ?? "commonjs",
    bin: manifest.bin ?? null,
    scripts: manifest.scripts ?? {},
    dependencies: {
      ink: dependencies.ink ?? null,
      react: dependencies.react ?? null,
      "ink-testing-library": dependencies["ink-testing-library"] ?? null,
    },
    installed: { ink: installed("ink"), react: installed("react") },
    lockfile,
  };
}

function versionTuple(version: string | null): number[] | null {
  if (!version) return null;
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(version);

  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function validateProject(projectRoot: string) {
  const project = inspectProject(projectRoot);
  const findings: Array<{ level: string; message: string }> = [];

  if (!project.dependencies.ink)
    findings.push({
      level: "error",
      message: "Ink is not declared in dependencies",
    });

  if (!project.dependencies.react)
    findings.push({
      level: "error",
      message: "React is not declared in dependencies",
    });
  const ink = versionTuple(project.installed.ink ?? project.dependencies.ink);

  const react = versionTuple(
    project.installed.react ?? project.dependencies.react,
  );

  if (!ink)
    findings.push({
      level: "warning",
      message: "Ink version cannot be determined",
    });

  if (
    ink &&
    ink[0] >= 8 &&
    react &&
    (react[0] < 19 || (react[0] === 19 && react[1] < 3))
  ) {
    findings.push({ level: "error", message: "Ink 8 requires React >=19.3.0" });
  }

  if (ink && ink[0] >= 6 && project.dependencies["ink-testing-library"]) {
    findings.push({
      level: "warning",
      message:
        "ink-testing-library v4 was developed for Ink 5; verify compatibility before component-input tests. Prefer the PTY tools.",
    });
  }

  if (!project.lockfile)
    findings.push({
      level: "warning",
      message: "No recognized dependency lockfile",
    });

  return {
    project,
    valid: !findings.some((finding) => finding.level === "error"),
    findings,
  };
}

// Compatibility-only search. The skill resource is the single source of
// bundled guidance for both MCP resources and the optional legacy tool.
type Guidance = { title: string; text: string; terms: string; path: string };

function readGuidance(): Guidance[] {
  // Source modules live under src/runtime/, but the bundled entry point
  // lives under dist/. Resolve the published skill in both layouts.
  const path = [
    new URL(
      "../skills/ink-development/references/ink-guidance.json",
      import.meta.url,
    ),
    new URL(
      "../../skills/ink-development/references/ink-guidance.json",
      import.meta.url,
    ),
  ].find((candidate) => existsSync(candidate));

  if (!path) throw new Error("Bundled Ink guidance is not installed");

  // SAFETY: this is the shipped guidance array, not a project manifest.
  return JSON.parse(readFileSync(path, "utf8")) as Guidance[];
}

export function searchDocs(query: string, version?: string, limit = 5) {
  const words = query.toLowerCase().split(/\W+/).filter(Boolean);

  if (!words.length) throw new Error("Documentation query must not be empty");

  const matches = readGuidance()
    .flatMap((doc) => {
      const haystack = (
        doc.title +
        " " +
        doc.terms +
        " " +
        doc.text
      ).toLowerCase();

      const score = words.reduce(
        (sum, word) => sum + (haystack.includes(word) ? 1 : 0),
        0,
      );

      return score > 0 ? [{ doc, score }] : [];
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(limit, 10)));

  const tag = version?.match(/^\d+(?:\.\d+){0,2}$/) ? "v" + version : "master";

  return {
    query,
    version: version ?? "not specified",
    note: "Curated guidance only. Verify component APIs against the installed Ink version.",
    results: matches.map(({ doc }) => ({
      title: doc.title,
      excerpt: doc.text,
      source:
        "https://github.com/vadimdemedes/ink/blob/" + tag + "/" + doc.path,
    })),
  };
}
