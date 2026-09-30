#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

const workspaceVersionCache = new Map();

export function clearWorkspaceVersionCache() {
  workspaceVersionCache.clear();
}

/**
 * Build a workspace package name -> version map by scanning `sourceRoot` for
 * package.json files (skipping node_modules, .git, and build output dirs).
 *
 * Used to resolve `workspace:*` specifiers to the *target* workspace
 * package's version (matching `pnpm pack` semantics) instead of the
 * dependent's own version. Results are cached per sourceRoot; call
 * `clearWorkspaceVersionCache()` in tests that mutate the fixture tree.
 */
export function readWorkspaceVersions(sourceRoot) {
  const root = resolve(sourceRoot);
  const cached = workspaceVersionCache.get(root);
  if (cached) return cached;

  const versions = new Map();
  const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".turbo"]);
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !(entry.isFile() && entry.name === "package.json")) continue;
      if (entry.isFile()) {
        try {
          const manifest = JSON.parse(readFileSync(join(dir, entry.name), "utf8"));
          if (typeof manifest?.name === "string" && typeof manifest?.version === "string") {
            if (!versions.has(manifest.name)) versions.set(manifest.name, manifest.version);
          }
        } catch {
          // Ignore unreadable/invalid manifests while scanning.
        }
        continue;
      }
      if (SKIP_DIRS.has(entry.name)) continue;
      stack.push(join(dir, entry.name));
    }
  }

  workspaceVersionCache.set(root, versions);
  return versions;
}

export const STRIPPED_STAGED_LIFECYCLE_SCRIPTS = [
  "prepack",
  "postpack",
  "prepublish",
  "prepublishOnly",
  "install",
  "postinstall",
  "prepare",
];

export function stripStagedLifecycleScripts(manifest) {
  if (!manifest || typeof manifest !== "object" || !manifest.scripts) return manifest;
  manifest.scripts = { ...manifest.scripts };
  for (const script of STRIPPED_STAGED_LIFECYCLE_SCRIPTS) {
    delete manifest.scripts[script];
  }
  if (Object.keys(manifest.scripts).length === 0) delete manifest.scripts;
  return manifest;
}

export function materializePublishManifest(pkg, options = {}) {
  const publishConfig = pkg.publishConfig ?? {};
  const publishManifest = { ...pkg };

  for (const key of ["main", "types", "exports", "bin"]) {
    if (publishConfig[key] !== undefined) publishManifest[key] = publishConfig[key];
  }

  // Resolve `workspace:*` to the target workspace package's version (pnpm
  // pack semantics). Falls back to the dependent's own version when the
  // target cannot be found, which preserves the release flow's uniform
  // calver behavior where every workspace version is identical.
  let workspaceVersions = options.workspaceVersions;
  if (!workspaceVersions && options.sourceRoot) {
    workspaceVersions = readWorkspaceVersions(options.sourceRoot);
  }

  for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    if (!publishManifest[section]) continue;
    publishManifest[section] = Object.fromEntries(
      Object.entries(publishManifest[section]).map(([name, specifier]) => {
        if (typeof specifier !== "string" || !specifier.startsWith("workspace:")) return [name, specifier];
        const range = specifier.slice("workspace:".length);
        const prefix = range === "^" || range === "~" ? range : "";
        const targetVersion = workspaceVersions?.get(name) ?? pkg.version;
        return [name, `${prefix}${targetVersion}`];
      }),
    );
  }

  delete publishManifest.publishConfig;
  stripStagedLifecycleScripts(publishManifest);
  return publishManifest;
}

export function createBundledInstallManifest(publishManifest, bundledDependencies) {
  const bundledDependencyNames = new Set(bundledDependencies);
  const installManifest = structuredClone(publishManifest);
  stripStagedLifecycleScripts(installManifest);

  delete installManifest.devDependencies;

  for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    if (!installManifest[section]) continue;
    installManifest[section] = Object.fromEntries(
      Object.entries(installManifest[section]).filter(([name]) => bundledDependencyNames.has(name)),
    );
    if (Object.keys(installManifest[section]).length === 0) delete installManifest[section];
  }

  return installManifest;
}

function patchedDependencyPackageName(specifier) {
  const versionSeparator = specifier.lastIndexOf("@");
  const packageNameEnd = specifier.startsWith("@") ? specifier.indexOf("/") : 0;
  if (packageNameEnd < 0) return specifier;
  return versionSeparator > packageNameEnd ? specifier.slice(0, versionSeparator) : specifier;
}

export function selectBundledDependencyPatches(
  destinationDir,
  bundledDependencies,
  patchedDependencies,
) {
  const patchesByPackageName = new Map();
  for (const [specifier, patchPath] of Object.entries(patchedDependencies)) {
    const packageName = patchedDependencyPackageName(specifier);
    const packagePatches = patchesByPackageName.get(packageName) ?? new Map();
    packagePatches.set(specifier, patchPath);
    patchesByPackageName.set(packageName, packagePatches);
  }

  const selectedPatches = [];
  for (const packageName of new Set(bundledDependencies)) {
    const packagePatches = patchesByPackageName.get(packageName);
    if (!packagePatches) continue;

    const installedManifestPath = resolve(
      destinationDir,
      "node_modules",
      packageName,
      "package.json",
    );
    let installedManifest;
    try {
      installedManifest = JSON.parse(readFileSync(installedManifestPath, "utf8"));
    } catch (cause) {
      throw new Error(
        `Cannot select a patch for bundled dependency ${packageName}: failed to read ${installedManifestPath}`,
        { cause },
      );
    }

    if (
      installedManifest.name !== packageName ||
      typeof installedManifest.version !== "string" ||
      installedManifest.version.length === 0
    ) {
      throw new Error(
        `Cannot select a patch for bundled dependency ${packageName}: installed package manifest must declare the expected name and a version`,
      );
    }

    const installedSpecifier = `${packageName}@${installedManifest.version}`;
    const patchPath = packagePatches.get(installedSpecifier);
    if (patchPath === undefined) {
      const configuredSpecifiers = [...packagePatches.keys()].sort().join(", ");
      throw new Error(
        `Cannot select a patch for bundled dependency ${packageName}: installed ${installedSpecifier}, but configured patches are ${configuredSpecifiers}`,
      );
    }
    if (typeof patchPath !== "string" || patchPath.length === 0) {
      throw new Error(`Patch path for ${installedSpecifier} must be a non-empty string`);
    }
    selectedPatches.push({ packageName, specifier: installedSpecifier, patchPath });
  }

  return selectedPatches;
}

export function applyBundledDependencyPatches(destinationDir, bundledDependencies, sourceRoot = repoRoot) {
  const rootPackage = JSON.parse(readFileSync(resolve(sourceRoot, "package.json"), "utf8"));
  const patchedDependencies = rootPackage.pnpm?.patchedDependencies ?? {};

  for (const { packageName, patchPath } of selectBundledDependencyPatches(
    destinationDir,
    bundledDependencies,
    patchedDependencies,
  )) {
    execFileSync(
      "patch",
      ["-p1", "--forward", "-d", resolve(destinationDir, "node_modules", packageName)],
      {
        input: readFileSync(resolve(sourceRoot, patchPath)),
        stdio: ["pipe", "inherit", "inherit"],
      },
    );
  }
}

export function prepareBundledPackage(sourceDir, destinationDir, { sourceRoot = repoRoot, workspaceVersions } = {}) {
  const sourcePackagePath = resolve(sourceDir, "package.json");
  const sourcePackage = JSON.parse(readFileSync(sourcePackagePath, "utf8"));
  const bundledDependencies = sourcePackage.bundleDependencies ?? sourcePackage.bundledDependencies ?? [];

  if (bundledDependencies.length === 0) {
    throw new Error(`${sourcePackage.name} does not declare bundled dependencies`);
  }

  rmSync(destinationDir, { recursive: true, force: true });
  mkdirSync(destinationDir, { recursive: true });
  // Git-install bootstrap compat: older published installers never ran the
  // release.sh packaging prep, so materialize generated `files` entries from
  // the repo's own inputs before the verbatim copy loop below. No-op when the
  // artifacts already exist (newer installers prepare them up front).
  if ((sourcePackage.files ?? []).includes("ui-dist") && !existsSync(resolve(sourceDir, "ui-dist"))) {
    const uiPrep = resolve(sourceRoot, "scripts/prepare-server-ui-dist.sh");
    if (existsSync(uiPrep)) {
      execFileSync("bash", [uiPrep], {
        cwd: sourceRoot,
        env: { ...process.env, PAPERCLIP_RELEASE_REUSE_UI_DIST: "1" },
        stdio: "inherit",
      });
    }
  }
  if ((sourcePackage.files ?? []).includes("skills") && !existsSync(resolve(sourceDir, "skills"))) {
    const repoSkills = resolve(sourceRoot, "skills");
    if (existsSync(repoSkills)) {
      cpSync(repoSkills, resolve(sourceDir, "skills"), { recursive: true });
    }
  }
  for (const entry of sourcePackage.files ?? []) {
    cpSync(resolve(sourceDir, entry), resolve(destinationDir, entry), { recursive: true });
  }
  for (const entry of ["README.md", "LICENSE", "LICENSE.md"]) {
    const sourcePath = resolve(sourceDir, entry);
    if (existsSync(sourcePath)) cpSync(sourcePath, resolve(destinationDir, entry));
  }

  const deployedPackagePath = resolve(destinationDir, "package.json");
  const resolvedWorkspaceVersions = workspaceVersions ?? readWorkspaceVersions(sourceRoot);
  const publishManifest = materializePublishManifest(sourcePackage, {
    workspaceVersions: resolvedWorkspaceVersions,
  });
  const installManifest = createBundledInstallManifest(publishManifest, bundledDependencies);
  writeFileSync(deployedPackagePath, `${JSON.stringify(installManifest, null, 2)}\n`);

  execFileSync(
    "npm",
    ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: destinationDir, stdio: "inherit" },
  );
  writeFileSync(deployedPackagePath, `${JSON.stringify(publishManifest, null, 2)}\n`);
  applyBundledDependencyPatches(destinationDir, bundledDependencies, sourceRoot);

  if (bundledDependencies.includes("acpx")) {
    const acpxPackage = JSON.parse(
      readFileSync(resolve(destinationDir, "node_modules/acpx/package.json"), "utf8"),
    );
    const expectedPatchMarker = {
      "0.12.0": "onAgentStderr",
      "0.13.1": "spawnEnvironment",
    }[acpxPackage.version];
    const acpxRuntime = readFileSync(
      resolve(destinationDir, "node_modules/acpx/dist/runtime.js"),
      "utf8",
    );
    if (!expectedPatchMarker || !acpxRuntime.includes(expectedPatchMarker)) {
      throw new Error(
        `staged acpx@${acpxPackage.version} runtime is missing the repository patch`,
      );
    }
  }

  if (bundledDependencies.includes("@agentclientprotocol/codex-acp")) {
    // Fail closed: the sandboxed ACP lane depends on the repository's
    // network-access hook (paperclipSandboxPolicy) inside the vendored
    // codex-acp runtime. A version bump without a rebased pnpm patch must
    // break the release here, never reship stock code with networkAccess=false.
    const codexAcpDist = readFileSync(
      resolve(destinationDir, "node_modules/@agentclientprotocol/codex-acp/dist/index.js"),
      "utf8",
    );
    if (
      !codexAcpDist.includes("function paperclipSandboxPolicy(") ||
      !codexAcpDist.includes("PAPERCLIP_CODEX_ACP_NETWORK_ACCESS")
    ) {
      throw new Error(
        "staged @agentclientprotocol/codex-acp runtime is missing the network-access hook",
      );
    }
  }

  if (bundledDependencies.includes("embedded-postgres")) {
    const embeddedPostgresSource = readFileSync(
      resolve(destinationDir, "node_modules/embedded-postgres/dist/index.js"),
      "utf8",
    );
    if (
      !embeddedPostgresSource.includes("const LC_MESSAGES_LOCALE = 'C';") ||
      !embeddedPostgresSource.includes("globalThis.process.env")
    ) {
      throw new Error("staged embedded-postgres runtime is missing the repository patch");
    }

    const embeddedPostgresPackage = JSON.parse(
      readFileSync(resolve(destinationDir, "node_modules/embedded-postgres/package.json"), "utf8"),
    );
    const stagedPackage = JSON.parse(readFileSync(deployedPackagePath, "utf8"));
    stagedPackage.optionalDependencies = {
      ...(stagedPackage.optionalDependencies ?? {}),
      ...(embeddedPostgresPackage.optionalDependencies ?? {}),
    };
    writeFileSync(deployedPackagePath, `${JSON.stringify(stagedPackage, null, 2)}\n`);
    rmSync(resolve(destinationDir, "node_modules/@embedded-postgres"), { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [sourceDir, destinationDir] = process.argv.slice(2);
  if (!sourceDir || !destinationDir) {
    console.error("Usage: prepare-bundled-package.mjs <source-dir> <destination-dir>");
    process.exit(1);
  }
  prepareBundledPackage(resolve(sourceDir), resolve(destinationDir));
}
