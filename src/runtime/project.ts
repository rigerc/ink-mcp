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

const documents = [
  {
    title: "Rendering components",
    text: "Render React terminal UI with Ink: import {render, Text, Box} from 'ink'; render(<App />). Use Text for strings and Box for layout.",
    terms: "render text box components react",
    path: "readme.md",
  },
  {
    title: "Layout with Box",
    text: "Box supports flexDirection, justifyContent, alignItems, flexGrow, padding, margin, width, height and borderStyle. Layout uses Yoga/Flexbox.",
    terms: "box flex layout width height padding border yoga",
    path: "readme.md",
  },
  {
    title: "Text component",
    text: "Text renders styled strings inside a terminal. Typical props include color, backgroundColor, bold, italic, underline, dimColor and wrap.",
    terms: "text typography color style wrap",
    path: "readme.md",
  },
  {
    title: "Keyboard with useInput",
    text: "useInput((input, key) => ...) handles normal text and keys such as upArrow, downArrow, return and escape. The application requires a TTY and active input.",
    terms: "useInput keyboard input arrow enter escape",
    path: "readme.md",
  },
  {
    title: "Focus management",
    text: "useFocus and useFocusManager allow controlled input routing between components; check isFocused before acting on input.",
    terms: "useFocus useFocusManager focus tab input",
    path: "readme.md",
  },
  {
    title: "Application lifecycle",
    text: "useApp exposes exit() to stop an Ink application. Asynchronous work and cleanup should respect mount/unmount lifecycle.",
    terms: "useApp exit lifecycle cleanup unmount",
    path: "readme.md",
  },
  {
    title: "Testing Ink",
    text: "ink-testing-library provides render(), lastFrame(), frames, rerender(), stdin.write(), and unmount(). For modern Ink versions and real keyboard semantics, test through a PTY.",
    terms: "test testing library render frames stdin",
    path: "readme.md",
  },
];

export function searchDocs(query: string, version?: string, limit = 5) {
  const words = query.toLowerCase().split(/\W+/).filter(Boolean);

  if (!words.length) throw new Error("Documentation query must not be empty");

  const matches = documents
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
