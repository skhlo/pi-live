import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  copyPiLivePayloadFixture,
  inspectPiLivePackagePayload,
  PI_LIVE_PI_VERSION,
  piLivePayloadFingerprint,
  verifyPiLivePayloadCopy,
} from "./pi-live-package.ts";

function sandboxLiteral(value: string): string {
  assert.ok(!/[\r\n\0]/.test(value), "Unsafe sandbox path");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function sandboxPolicy(scratch: string): string {
  return `(version 1)
(allow default)
(deny network*)
(deny process-fork)
(deny process-exec (require-not (literal ${sandboxLiteral(process.execPath)})))
(deny file-write* (require-not (subpath ${sandboxLiteral(scratch)})))
`;
}

export type PiLivePackageNodeModules = "absent" | "present";

export type PiLiveLoaderReceipt = {
  pi: "0.87.1";
  tui: "0.87.1";
  piAliases: "loader-supplied";
  networkError: "EPERM";
  childProcessError: "EPERM";
  fileWriteError: "EPERM";
  nativeAddons: "disabled";
  packageNodeModules: PiLivePackageNodeModules;
  extensions: 1;
};

type DirectoryIdentity = { dev: number; ino: number; mode: number };

function directoryIdentity(directory: string): DirectoryIdentity {
  const info = lstatSync(directory);
  assert.ok(info.isDirectory() && !info.isSymbolicLink());
  return { dev: info.dev, ino: info.ino, mode: info.mode & 0o777 };
}

function assertEmpty(directory: string): void {
  assert.deepEqual(
    readdirSync(directory),
    [],
    `Expected an empty directory after loader check: ${directory}`,
  );
}

function packageRootFromEntry(entry: string, expectedName: string): string {
  let directory = path.dirname(fileURLToPath(entry));
  for (;;) {
    const manifestPath = path.join(directory, "package.json");
    if (existsSync(manifestPath)) {
      const info = lstatSync(manifestPath);
      assert.ok(
        info.isFile() && !info.isSymbolicLink(),
        `Loader package manifest is redirected: ${expectedName}`,
      );
      const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (
        manifest !== null &&
        typeof manifest === "object" &&
        !Array.isArray(manifest) &&
        (manifest as Record<string, unknown>).name === expectedName
      )
        return realpathSync(directory);
    }
    const parent = path.dirname(directory);
    assert.notEqual(
      parent,
      directory,
      `Could not locate loader package: ${expectedName}`,
    );
    directory = parent;
  }
}

function loaderManifestPaths(): { pi: string; tui: string } {
  const piRoot = packageRootFromEntry(
    import.meta.resolve("@earendil-works/pi-coding-agent"),
    "@earendil-works/pi-coding-agent",
  );
  const tuiRoot = packageRootFromEntry(
    import.meta.resolve("@earendil-works/pi-tui"),
    "@earendil-works/pi-tui",
  );
  return {
    pi: path.join(piRoot, "package.json"),
    tui: path.join(tuiRoot, "package.json"),
  };
}

function assertOutsideAmbientNodeModules(packageRoot: string): void {
  let directory = path.dirname(packageRoot);
  for (;;) {
    const ambient = path.join(directory, "node_modules");
    assert.equal(
      lstatSync(ambient, { throwIfNoEntry: false }),
      undefined,
      `Loader package fixture has ambient node_modules: ${ambient}`,
    );
    const parent = path.dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}

function assertNodeModulesState(
  packageRoot: string,
  expected: PiLivePackageNodeModules,
): void {
  const nodeModules = path.join(packageRoot, "node_modules");
  const info = lstatSync(nodeModules, { throwIfNoEntry: false });
  if (expected === "absent") {
    assert.equal(info, undefined, "Package node_modules must be absent");
    return;
  }
  assert.ok(
    info?.isDirectory() && !info.isSymbolicLink(),
    "Package node_modules must be a real directory",
  );
}

export function checkedPiLiveCli(): string {
  return path.join(
    path.dirname(loaderManifestPaths().pi),
    "dist/bundle/cli.js",
  );
}

export function checkPiLiveLoader(
  requestedPackageRoot: string,
  packageNodeModules: PiLivePackageNodeModules,
  verifyInstalledPackage?: () => void,
): PiLiveLoaderReceipt {
  assert.equal(process.platform, "darwin", "Loader receipt requires macOS");
  assert.equal(process.arch, "arm64", "Loader receipt requires arm64");

  const sandboxPath = "/usr/bin/sandbox-exec";
  const sandboxInfo = lstatSync(sandboxPath);
  assert.equal(sandboxInfo.isFile(), true, "sandbox-exec is unavailable");

  const packageRoot = realpathSync(requestedPackageRoot);
  assertOutsideAmbientNodeModules(packageRoot);
  assertNodeModulesState(packageRoot, packageNodeModules);
  if (packageNodeModules === "present")
    assert.ok(
      verifyInstalledPackage,
      "Present loader checks require production closure verification",
    );

  const packageIdentity = directoryIdentity(packageRoot);
  const payloadBefore = piLivePayloadFingerprint(packageRoot);
  verifyInstalledPackage?.();

  const manifests = loaderManifestPaths();
  const repositoryRoot = path.resolve(import.meta.dirname, "..");
  const temporaryRoot = mkdtempSync(
    path.join(tmpdir(), "pi-live-loader-check-"),
  );
  let result: SpawnSyncReturns<string> | undefined;
  try {
    const homeDirectory = path.join(temporaryRoot, "home");
    const agentDirectory = path.join(temporaryRoot, "pi-agent");
    const sessionDirectory = path.join(temporaryRoot, "pi-sessions");
    const workspace = path.join(temporaryRoot, "workspace");
    const scratch = path.join(temporaryRoot, "scratch");
    const xdgConfig = path.join(temporaryRoot, "xdg-config");
    const xdgCache = path.join(temporaryRoot, "xdg-cache");
    const xdgData = path.join(temporaryRoot, "xdg-data");
    const xdgState = path.join(temporaryRoot, "xdg-state");
    const isolatedDirectories = [
      homeDirectory,
      agentDirectory,
      sessionDirectory,
      workspace,
      scratch,
      xdgConfig,
      xdgCache,
      xdgData,
      xdgState,
    ];
    for (const directory of isolatedDirectories)
      mkdirSync(directory, { mode: 0o700 });
    for (const directory of isolatedDirectories) assertEmpty(directory);
    const nonScratchDirectories = isolatedDirectories.filter(
      (directory) => directory !== scratch,
    );
    const identities = new Map(
      nonScratchDirectories.map((directory) => [
        directory,
        directoryIdentity(directory),
      ]),
    );

    result = spawnSync(
      sandboxPath,
      [
        "-p",
        sandboxPolicy(realpathSync(scratch)),
        process.execPath,
        "--no-addons",
        path.join(repositoryRoot, "scripts/pi-live-loader-probe.ts"),
        packageRoot,
        agentDirectory,
        sessionDirectory,
        manifests.pi,
        manifests.tui,
        packageNodeModules,
      ],
      {
        cwd: workspace,
        encoding: "utf8",
        env: {
          HOME: homeDirectory,
          LANG: "en_US.UTF-8",
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          PI_CODING_AGENT_DIR: agentDirectory,
          PI_CODING_AGENT_SESSION_DIR: sessionDirectory,
          PI_OFFLINE: "1",
          PI_SKIP_VERSION_CHECK: "1",
          PI_TELEMETRY: "0",
          TMPDIR: `${scratch}${path.sep}`,
          USERPROFILE: homeDirectory,
          XDG_CACHE_HOME: xdgCache,
          XDG_CONFIG_HOME: xdgConfig,
          XDG_DATA_HOME: xdgData,
          XDG_STATE_HOME: xdgState,
        },
        timeout: 30_000,
      },
    );

    for (const directory of nonScratchDirectories) {
      assert.deepEqual(
        directoryIdentity(directory),
        identities.get(directory),
        `Pi Live loader check replaced an isolation directory: ${directory}`,
      );
      assertEmpty(directory);
    }
  } finally {
    try {
      assert.deepEqual(
        directoryIdentity(packageRoot),
        packageIdentity,
        "Pi Live loader check replaced the supplied package",
      );
      assert.equal(
        piLivePayloadFingerprint(packageRoot),
        payloadBefore,
        "Pi Live loader check changed the package payload",
      );
      assertNodeModulesState(packageRoot, packageNodeModules);
      verifyInstalledPackage?.();
    } finally {
      rmSync(temporaryRoot, { recursive: true });
    }
  }

  assert.ok(result, "Pi Live loader probe did not run");
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const outputLines = result.stdout.trim().split("\n");
  assert.equal(
    outputLines.length,
    1,
    "Pi Live loader probe emitted unexpected stdout",
  );
  const receipt: unknown = JSON.parse(outputLines[0]!);
  const expected: PiLiveLoaderReceipt = {
    pi: PI_LIVE_PI_VERSION,
    tui: PI_LIVE_PI_VERSION,
    piAliases: "loader-supplied",
    networkError: "EPERM",
    childProcessError: "EPERM",
    fileWriteError: "EPERM",
    nativeAddons: "disabled",
    packageNodeModules,
    extensions: 1,
  };
  assert.deepEqual(receipt, expected);
  return expected;
}

function main(): void {
  assert.equal(
    process.argv.length,
    2,
    "Usage: node scripts/check-pi-live-loader.ts",
  );
  const repositoryRoot = path.resolve(import.meta.dirname, "..");
  const source = inspectPiLivePackagePayload(repositoryRoot);
  const fixtureParent = mkdtempSync(
    path.join(tmpdir(), "pi-live-loader-package-"),
  );
  const packageRoot = path.join(fixtureParent, "package");
  try {
    copyPiLivePayloadFixture(source, packageRoot);
    checkPiLiveLoader(packageRoot, "absent");
    verifyPiLivePayloadCopy(packageRoot, source);
  } finally {
    rmSync(fixtureParent, { recursive: true });
  }
  console.log(
    "Verified Pi Live loader receipt: isolated package without ambient dependencies, loader-supplied Pi/TUI 0.87.1 aliases, OS network/process/non-scratch writes denied, native addons disabled, and unchanged empty credential/session/workspace directories.",
  );
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
)
  try {
    main();
  } catch (error: unknown) {
    console.error(
      `pi-live loader check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
