import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PI_LIVE_REPOSITORY_ROOT = fileURLToPath(
  new URL("..", import.meta.url),
);
export const PI_LIVE_PNPM_VERSION = "11.8.0";
export const PI_LIVE_PI_VERSION = "0.87.1";
export const PI_LIVE_MINIMUM_NODE = [22, 19, 0] as const;
export const PI_LIVE_PUBLIC_REGISTRY = "https://registry.npmjs.org/";
export const PI_LIVE_FULL_LOCK_SHA256 =
  "7230a1cf633b74dc0fe3d7b6ec014f66edb636623a92e060dd75d0adf9d9e597";
export const PI_LIVE_PRODUCTION_LOCK_SHA256 =
  "f179cf0d853740aac7469e0ea3a41ae222e4d83d51c6e1a3efa6da88ada6d846";
export const PI_LIVE_NATIVE_MANIFEST_SHA256 =
  "9e985ae0ee2cd229326f9d1fed99ca0341a324720c96fcc2e123eaea4f97a44e";
export const PI_LIVE_NATIVE_README_SHA256 =
  "ee2db3b14282526ae7333398352640afd2f7a84b0c96d43e1eb97340e930498b";
export const PI_LIVE_NATIVE_BINARY_SHA256 =
  "35bbb69631c88b2691941a1df660eac3416e43cbef6ed0309a4742defde51cf4";
export const PI_LIVE_NOTICE_MANIFEST_RELATIVE = "notices/NOTICE-MANIFEST.json";
export const PI_LIVE_NOTICE_MANIFEST_SHA256 =
  "3a674e1b218af8db3630e85dd0c468cdd39f09b4832010ee76e65f811b2bbdf2";
export const PI_LIVE_NOTICE_FILE_COUNT = 52;
export const PI_LIVE_NOTICE_PURPOSE =
  "Exact full texts and source headers gathered for byte-proved resources, direct native components, the pinned Rust runtime, and accepted residuals. This is not a target-specific SBOM or legal-clearance claim.";

export const PI_LIVE_PRODUCTION_INSTALL_ARGS = [
  "install",
  "--ignore-workspace",
  "--prod",
  "--frozen-lockfile",
  "--ignore-scripts",
  "--config.auto-install-peers=false",
] as const;

export const PI_LIVE_PRODUCTION_PACKAGES = [
  [
    "@oh-my-pi+pi-natives-darwin-arm64@17.2.9",
    "@oh-my-pi/pi-natives-darwin-arm64",
    "17.2.9",
  ],
  ["agent-base@9.0.0", "agent-base", "9.0.0"],
  ["debug@4.4.3", "debug", "4.4.3"],
  ["https-proxy-agent@9.1.0", "https-proxy-agent", "9.1.0"],
  ["ms@2.1.3", "ms", "2.1.3"],
  ["proxy-agent-negotiate@1.1.0", "proxy-agent-negotiate", "1.1.0"],
  ["proxy-from-env@2.1.0", "proxy-from-env", "2.1.0"],
  ["undici@8.10.0", "undici", "8.10.0"],
  ["ws@8.21.2", "ws", "8.21.2"],
] as const;

const PI_LIVE_PRODUCTION_PACKAGE_LINKS: Record<string, readonly string[]> = {
  "@oh-my-pi/pi-natives-darwin-arm64": [],
  "agent-base": [],
  debug: ["ms"],
  "https-proxy-agent": ["agent-base", "debug", "proxy-agent-negotiate"],
  ms: [],
  "proxy-agent-negotiate": [],
  "proxy-from-env": [],
  undici: [],
  ws: [],
};

export const PI_LIVE_PAYLOAD_ROOT_FILES = [
  "LICENSE",
  "PROVENANCE.md",
  "THIRD_PARTY_NOTICES.md",
  "UPSTREAM_THIRD_PARTY_NOTICES.md",
  "index.ts",
  "package.json",
  "pnpm-lock.yaml",
] as const;

export const PI_LIVE_PAYLOAD_SOURCE_FILES = [
  "src/compatibility.ts",
  "src/live.ts",
  "src/pi-tui.d.ts",
  "src/preferences.ts",
] as const;

export const PI_LIVE_MANIFEST = {
  name: "pi-live",
  version: "0.0.0",
  private: true,
  description:
    "Experimental standalone Pi Live extension; currently setup-only",
  type: "module",
  packageManager: `pnpm@${PI_LIVE_PNPM_VERSION}`,
  license: "MIT",
  scripts: {
    test: "node --test scripts/*.test.ts",
    typecheck: "tsc --noEmit",
    format: "prettier --write .",
    "format:check": "prettier --check .",
    "check:source": "node scripts/import-pi-live.ts check",
    "check:package": "node scripts/check-pi-live.ts",
    "check:loader": "node scripts/check-pi-live-loader.ts",
    "check:production": "node scripts/check-pi-live-production.ts",
    "check:transfer": "node scripts/check-transfer.ts",
  },
  engines: { node: ">=22.19.0" },
  dependencies: {
    "https-proxy-agent": "9.1.0",
    "proxy-from-env": "2.1.0",
    undici: "8.10.0",
    ws: "8.21.2",
  },
  peerDependencies: {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
  },
  devDependencies: {
    "@earendil-works/pi-coding-agent": "0.87.1",
    "@earendil-works/pi-tui": "0.87.1",
    "@types/node": "22.19.19",
    prettier: "3.9.6",
    typescript: "5.9.3",
  },
  optionalDependencies: {
    "@oh-my-pi/pi-natives-darwin-arm64": "17.2.9",
  },
  pi: { extensions: ["./index.ts"] },
} as const;

export type PiLivePayloadFile = {
  relative: string;
  absolute: string;
  sha256: string;
  mode: number;
};

export type PiLiveNoticeFile = {
  relative: string;
  packageRelative: string;
  source: string;
  bytes: number;
  sha256: string;
};

export type PiLiveNoticeCorpus = {
  files: PiLiveNoticeFile[];
  directories: string[];
};

export type PiLivePackagePayload = {
  root: string;
  files: PiLivePayloadFile[];
  directories: string[];
  noticeCorpus: PiLiveNoticeCorpus;
  hashes: Record<string, string>;
  fingerprint: string;
};

export function piLiveSha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function jsonObject(value: unknown, label: string): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be a JSON object`,
  );
  return value as Record<string, unknown>;
}

function assertExactNames(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  const sortedActual = [...actual].sort(compare);
  const sortedExpected = [...expected].sort(compare);
  const missing = sortedExpected.filter((name) => !sortedActual.includes(name));
  const extra = sortedActual.filter((name) => !sortedExpected.includes(name));
  assert.ok(
    missing.length === 0 && extra.length === 0,
    `${label} inventory differs (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"})`,
  );
}

function assertRealDirectory(directory: string, label: string): void {
  const info = fs.lstatSync(directory, { throwIfNoEntry: false });
  assert.ok(
    info?.isDirectory() && !info.isSymbolicLink(),
    `${label} must be a real directory`,
  );
  assert.equal(
    fs.realpathSync(directory),
    directory,
    `${label} must not be redirected`,
  );
}

function assertRegularUnredirectedFile(
  file: string,
  label: string,
  expectedMode = 0o644,
): void {
  const info = fs.lstatSync(file, { throwIfNoEntry: false });
  assert.ok(info, `${label} must be a regular file`);
  assert.ok(
    info.isFile() && !info.isSymbolicLink(),
    `${label} must be a regular file`,
  );
  assert.equal(fs.realpathSync(file), file, `${label} must not be redirected`);
  assert.equal(
    info.mode & 0o777,
    expectedMode,
    `${label} mode must be ${expectedMode.toString(8).padStart(4, "0")}`,
  );
}

function readJsonFile(file: string, label: string): Record<string, unknown> {
  const info = fs.lstatSync(file, { throwIfNoEntry: false });
  assert.ok(
    info?.isFile() && !info.isSymbolicLink(),
    `${label} is missing or redirected`,
  );
  try {
    return jsonObject(JSON.parse(fs.readFileSync(file, "utf8")), label);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} is malformed`);
    throw error;
  }
}

function collectTreeInventory(
  root: string,
  relative: string,
  files: string[],
  directories: string[],
): void {
  const directory = path.join(root, ...relative.split("/"));
  assertRealDirectory(directory, `Pi Live payload directory ${relative}`);
  directories.push(relative);
  for (const entry of fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => compare(left.name, right.name))) {
    const childRelative = `${relative}/${entry.name}`;
    const child = path.join(directory, entry.name);
    const childInfo = fs.lstatSync(child);
    assert.ok(
      !childInfo.isSymbolicLink(),
      `Pi Live payload is redirected: ${childRelative}`,
    );
    if (childInfo.isDirectory()) {
      collectTreeInventory(root, childRelative, files, directories);
      continue;
    }
    assert.ok(
      childInfo.isFile(),
      `Pi Live payload is not a regular file: ${childRelative}`,
    );
    assert.equal(
      childInfo.mode & 0o777,
      0o644,
      `Pi Live payload file mode must be 0644: ${childRelative}`,
    );
    files.push(childRelative);
  }
}

function inspectPiLiveNoticeCorpus(root: string): PiLiveNoticeCorpus {
  const noticesRoot = path.join(root, "notices");
  assertRealDirectory(noticesRoot, "Pi Live notice corpus");

  const manifestPath = path.join(
    root,
    ...PI_LIVE_NOTICE_MANIFEST_RELATIVE.split("/"),
  );
  assertRegularUnredirectedFile(manifestPath, "Pi Live notice manifest");
  const manifestBytes = fs.readFileSync(manifestPath);
  assert.equal(
    piLiveSha256(manifestBytes),
    PI_LIVE_NOTICE_MANIFEST_SHA256,
    "Pi Live notice manifest differs from the exact reviewed manifest",
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new Error("Pi Live notice manifest is malformed");
  }
  const manifest = jsonObject(parsed, "Pi Live notice manifest");
  assertExactNames(
    Object.keys(manifest),
    ["schemaVersion", "purpose", "files"],
    "Pi Live notice manifest field",
  );
  assert.equal(
    manifest.schemaVersion,
    1,
    "Pi Live notice manifest schema version differs",
  );
  assert.equal(
    manifest.purpose,
    PI_LIVE_NOTICE_PURPOSE,
    "Pi Live notice manifest purpose differs",
  );
  const fileMap = jsonObject(manifest.files, "Pi Live notice manifest files");
  const names = Object.keys(fileMap).sort(compare);
  assert.equal(
    names.length,
    PI_LIVE_NOTICE_FILE_COUNT,
    `Pi Live notice manifest must contain ${PI_LIVE_NOTICE_FILE_COUNT} files`,
  );

  const expectedDirectories = new Set<string>(["notices"]);
  const files = names.map((relative): PiLiveNoticeFile => {
    assert.ok(
      relative.length > 0 &&
        !path.posix.isAbsolute(relative) &&
        path.posix.normalize(relative) === relative &&
        !relative.includes("\\") &&
        relative.split("/").every((part) => part !== ".." && part !== "."),
      `Pi Live notice manifest path is invalid: ${relative}`,
    );
    const metadata = jsonObject(
      fileMap[relative],
      `Pi Live notice metadata for ${relative}`,
    );
    assertExactNames(
      Object.keys(metadata),
      ["source", "bytes", "sha256"],
      `Pi Live notice metadata field for ${relative}`,
    );
    const source = metadata.source;
    assert.ok(
      typeof source === "string" &&
        source.length > 0 &&
        source.trim() === source,
      `Pi Live notice source label is invalid: ${relative}`,
    );
    const byteCount = metadata.bytes;
    assert.ok(
      typeof byteCount === "number" &&
        Number.isSafeInteger(byteCount) &&
        byteCount > 0,
      `Pi Live notice byte count is invalid: ${relative}`,
    );
    const sha256 = metadata.sha256;
    assert.ok(
      typeof sha256 === "string",
      `Pi Live notice SHA-256 is invalid: ${relative}`,
    );
    assert.match(
      sha256,
      /^[0-9a-f]{64}$/,
      `Pi Live notice SHA-256 is invalid: ${relative}`,
    );

    let parent = path.posix.dirname(relative);
    while (parent !== ".") {
      expectedDirectories.add(`notices/${parent}`);
      parent = path.posix.dirname(parent);
    }
    const packageRelative = `notices/${relative}`;
    const absolute = path.join(root, ...packageRelative.split("/"));
    assertRegularUnredirectedFile(
      absolute,
      `Pi Live notice corpus entry ${relative}`,
    );
    const bytes = fs.readFileSync(absolute);
    assert.equal(
      bytes.byteLength,
      byteCount,
      `Pi Live notice byte count differs: ${relative}`,
    );
    assert.equal(
      piLiveSha256(bytes),
      sha256,
      `Pi Live notice SHA-256 differs: ${relative}`,
    );
    return {
      relative,
      packageRelative,
      source,
      bytes: byteCount,
      sha256,
    };
  });

  const actualFiles: string[] = [];
  const actualDirectories: string[] = [];
  collectTreeInventory(root, "notices", actualFiles, actualDirectories);
  assertExactNames(
    actualFiles,
    [
      PI_LIVE_NOTICE_MANIFEST_RELATIVE,
      ...files.map(({ packageRelative }) => packageRelative),
    ],
    "Pi Live notice file",
  );
  assertExactNames(
    actualDirectories,
    [...expectedDirectories],
    "Pi Live notice directory",
  );

  return { files, directories: actualDirectories.sort(compare) };
}

function readManifest(root: string): Record<string, unknown> {
  const manifest = readJsonFile(
    path.join(root, "package.json"),
    "Pi Live package manifest",
  );
  assert.deepEqual(
    manifest,
    PI_LIVE_MANIFEST,
    "Pi Live package manifest differs from the exact standalone policy",
  );
  const scripts = jsonObject(manifest.scripts, "Pi Live package scripts");
  for (const lifecycle of [
    "preinstall",
    "install",
    "postinstall",
    "prepare",
    "prepublish",
    "prepublishOnly",
    "publish",
    "postpublish",
    "prepack",
    "postpack",
    "dependencies",
  ])
    assert.ok(
      !(lifecycle in scripts),
      `Pi Live package lifecycle hook is forbidden: ${lifecycle}`,
    );
  return manifest;
}

export function inspectPiLivePackagePayload(
  requestedRoot = PI_LIVE_REPOSITORY_ROOT,
): PiLivePackagePayload {
  const root = fs.realpathSync(requestedRoot);
  assertRealDirectory(root, "Pi Live package root");

  const noticeCorpus = inspectPiLiveNoticeCorpus(root);
  const sourceFiles: string[] = [];
  const sourceDirectories: string[] = [];
  collectTreeInventory(root, "src", sourceFiles, sourceDirectories);
  assertExactNames(
    sourceFiles,
    PI_LIVE_PAYLOAD_SOURCE_FILES,
    "Pi Live runtime source file",
  );
  assertExactNames(
    sourceDirectories,
    ["src"],
    "Pi Live runtime source directory",
  );

  for (const relative of PI_LIVE_PAYLOAD_ROOT_FILES)
    assertRegularUnredirectedFile(
      path.join(root, relative),
      `Pi Live payload file ${relative}`,
    );
  readManifest(root);

  const lock = fs.readFileSync(path.join(root, "pnpm-lock.yaml"));
  assert.equal(
    piLiveSha256(lock),
    PI_LIVE_FULL_LOCK_SHA256,
    "Pi Live full lock differs from the reviewed standalone lock",
  );
  assert.match(
    lock.toString("utf8"),
    /settings:\n  autoInstallPeers: false\n/,
    "Pi Live full lock must disable automatic peer installation",
  );

  const relatives = [
    ...PI_LIVE_PAYLOAD_ROOT_FILES,
    ...PI_LIVE_PAYLOAD_SOURCE_FILES,
    PI_LIVE_NOTICE_MANIFEST_RELATIVE,
    ...noticeCorpus.files.map(({ packageRelative }) => packageRelative),
  ].sort(compare);
  assert.equal(
    relatives.length,
    new Set(relatives).size,
    "Pi Live package payload contains duplicate paths",
  );
  const files = relatives.map((relative): PiLivePayloadFile => {
    const absolute = path.join(root, ...relative.split("/"));
    assertRegularUnredirectedFile(absolute, `Pi Live payload file ${relative}`);
    const info = fs.lstatSync(absolute);
    return {
      relative,
      absolute,
      sha256: piLiveSha256(fs.readFileSync(absolute)),
      mode: info.mode & 0o777,
    };
  });
  const hashes = Object.fromEntries(
    files.map(({ relative, sha256 }) => [relative, sha256]),
  );
  const fingerprint = piLiveSha256(
    JSON.stringify(
      files.map(({ relative, sha256, mode }) => ({
        relative,
        sha256,
        mode,
      })),
    ),
  );
  const directories = [
    ".",
    ...sourceDirectories,
    ...noticeCorpus.directories,
  ].sort(compare);
  return { root, files, directories, noticeCorpus, hashes, fingerprint };
}

export function copyPiLivePayloadFixture(
  source: PiLivePackagePayload,
  targetRoot: string,
): void {
  assert.equal(
    fs.lstatSync(targetRoot, { throwIfNoEntry: false }),
    undefined,
    "Pi Live fixture target must not already exist",
  );
  fs.mkdirSync(targetRoot, { mode: 0o700 });
  for (const relative of source.directories) {
    if (relative === ".") continue;
    fs.mkdirSync(path.join(targetRoot, ...relative.split("/")), {
      recursive: true,
      mode: 0o700,
    });
  }
  for (const item of source.files) {
    const target = path.join(targetRoot, ...item.relative.split("/"));
    const bytes = fs.readFileSync(item.absolute);
    assert.equal(
      piLiveSha256(bytes),
      item.sha256,
      `Pi Live source changed while copying fixture: ${item.relative}`,
    );
    fs.writeFileSync(target, bytes, { flag: "wx", mode: item.mode });
    fs.chmodSync(target, item.mode);
  }
  verifyPiLivePayloadCopy(targetRoot, source);
}

export function verifyPiLivePayloadCopy(
  targetRoot: string,
  source: PiLivePackagePayload,
): PiLivePackagePayload {
  const target = inspectPiLivePackagePayload(targetRoot);
  assertExactNames(
    target.files.map(({ relative }) => relative),
    source.files.map(({ relative }) => relative),
    "Pi Live fixture payload file",
  );
  for (const expected of source.files) {
    const actual = target.files.find(
      ({ relative }) => relative === expected.relative,
    );
    assert.ok(actual, `Missing Pi Live fixture payload: ${expected.relative}`);
    assert.deepEqual(
      { sha256: actual.sha256, mode: actual.mode },
      { sha256: expected.sha256, mode: expected.mode },
      `Pi Live fixture payload differs: ${expected.relative}`,
    );
  }
  assert.equal(
    target.fingerprint,
    source.fingerprint,
    "Pi Live fixture payload fingerprint differs",
  );
  return target;
}

export function piLivePayloadFingerprint(root: string): string {
  return inspectPiLivePackagePayload(root).fingerprint;
}

export function versionTuple(
  version: string,
): readonly [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  assert.ok(match, `Invalid Node version: ${version}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function versionAtLeast(
  actual: readonly [number, number, number],
  minimum: readonly [number, number, number],
): boolean {
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] !== minimum[index])
      return actual[index]! > minimum[index]!;
  }
  return true;
}

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

function assertContainedTree(root: string, target = root): void {
  const info = fs.lstatSync(target);
  if (info.isSymbolicLink()) {
    let resolved: string;
    try {
      resolved = fs.realpathSync.native(target);
    } catch {
      throw new Error(
        `Pi Live dependency symlink is broken: ${path.relative(root, target)}`,
      );
    }
    assert.ok(
      isInside(root, resolved),
      `Pi Live dependency symlink escapes node_modules: ${path.relative(root, target)}`,
    );
    return;
  }
  assert.ok(
    info.isDirectory() || info.isFile(),
    `Pi Live dependency tree contains a special file: ${path.relative(root, target)}`,
  );
  if (!info.isDirectory()) return;
  for (const name of fs.readdirSync(target).sort(compare))
    assertContainedTree(root, path.join(target, name));
}

function assertLinkTo(link: string, target: string, label: string): void {
  const info = fs.lstatSync(link, { throwIfNoEntry: false });
  assert.ok(info?.isSymbolicLink(), `${label} is missing or is not a symlink`);
  assert.equal(
    fs.realpathSync.native(link),
    target,
    `${label} resolves to the wrong package`,
  );
}

function assertPackageNodeModulesEntries(
  nodeModules: string,
  packageNames: readonly string[],
  label: string,
): void {
  const unscoped: string[] = [];
  const scopes = new Map<string, string[]>();
  for (const packageName of packageNames) {
    if (!packageName.startsWith("@")) {
      unscoped.push(packageName);
      continue;
    }
    const [scope, name, ...rest] = packageName.split("/");
    assert.ok(
      scope && name && rest.length === 0,
      `Invalid package name: ${packageName}`,
    );
    const entries = scopes.get(scope) ?? [];
    entries.push(name);
    scopes.set(scope, entries);
  }
  assertExactNames(
    fs.readdirSync(nodeModules),
    [...unscoped, ...scopes.keys()],
    label,
  );
  for (const [scope, entries] of scopes) {
    const scopeRoot = path.join(nodeModules, scope);
    const scopeInfo = fs.lstatSync(scopeRoot, { throwIfNoEntry: false });
    assert.ok(
      scopeInfo?.isDirectory() && !scopeInfo.isSymbolicLink(),
      `${label} scope ${scope} must be a real directory`,
    );
    assertExactNames(
      fs.readdirSync(scopeRoot),
      entries,
      `${label} scope ${scope}`,
    );
  }
}

function assertHash(file: string, expected: string, label: string): void {
  const info = fs.lstatSync(file, { throwIfNoEntry: false });
  assert.ok(
    info?.isFile() && !info.isSymbolicLink(),
    `${label} is missing or redirected`,
  );
  assert.equal(
    piLiveSha256(fs.readFileSync(file)),
    expected,
    `${label} differs from the reviewed artifact`,
  );
}

export function verifyPiLiveProductionInstall(requestedRoot: string): void {
  const root = fs.realpathSync(requestedRoot);
  const nodeModules = path.join(root, "node_modules");
  assertRealDirectory(nodeModules, "Pi Live production node_modules");
  assertContainedTree(nodeModules);
  const virtualStore = path.join(nodeModules, ".pnpm");

  assertExactNames(
    fs.readdirSync(nodeModules),
    [
      ".modules.yaml",
      ".package-map.json",
      ".pnpm",
      ".pnpm-workspace-state-v1.json",
      "@oh-my-pi",
      "https-proxy-agent",
      "proxy-from-env",
      "undici",
      "ws",
    ],
    "Pi Live installed node_modules",
  );
  assertExactNames(
    fs.readdirSync(path.join(nodeModules, "@oh-my-pi")),
    ["pi-natives-darwin-arm64"],
    "Pi Live installed native scope",
  );
  assertExactNames(
    fs.readdirSync(virtualStore),
    [
      ...PI_LIVE_PRODUCTION_PACKAGES.map(([folder]) => folder),
      "lock.yaml",
      "node_modules",
    ],
    "Pi Live production virtual-store package",
  );
  assertExactNames(
    fs.readdirSync(path.join(virtualStore, "node_modules")),
    ["agent-base", "debug", "ms", "proxy-agent-negotiate"],
    "Pi Live hoisted production package",
  );

  const productionLock = fs.readFileSync(path.join(virtualStore, "lock.yaml"));
  assert.equal(
    piLiveSha256(productionLock),
    PI_LIVE_PRODUCTION_LOCK_SHA256,
    "Pi Live production lock differs from the exact reviewed closure",
  );
  const productionLockText = productionLock.toString("utf8");
  assert.match(
    productionLockText,
    /settings:\n  autoInstallPeers: false\n/,
    "Pi Live production lock must disable automatic peer installation",
  );
  assert.ok(
    !productionLockText.includes("@earendil-works/pi-coding-agent") &&
      !productionLockText.includes("@earendil-works/pi-tui"),
    "Pi Live production lock must not contain Pi or TUI peers",
  );

  assertExactNames(
    Object.keys(PI_LIVE_PRODUCTION_PACKAGE_LINKS),
    PI_LIVE_PRODUCTION_PACKAGES.map(([, name]) => name),
    "Pi Live production lock topology",
  );
  const packageRoots = new Map<string, string>();
  const packageIds = new Map<string, string>(
    PI_LIVE_PRODUCTION_PACKAGES.map(([, name, version]) => [
      name,
      `${name}@${version}`,
    ]),
  );
  for (const [folder, name, version] of PI_LIVE_PRODUCTION_PACKAGES) {
    const packageNodeModules = path.join(virtualStore, folder, "node_modules");
    const linkedDependencies = PI_LIVE_PRODUCTION_PACKAGE_LINKS[name];
    assert.ok(linkedDependencies, `Missing Pi Live lock topology for ${name}`);
    assertPackageNodeModulesEntries(
      packageNodeModules,
      [name, ...linkedDependencies],
      `Pi Live production package links ${name}`,
    );
    const packageRoot = path.join(packageNodeModules, ...name.split("/"));
    const packageInfo = fs.lstatSync(packageRoot, { throwIfNoEntry: false });
    assert.ok(
      packageInfo?.isDirectory() && !packageInfo.isSymbolicLink(),
      `Pi Live production package root must be a real directory: ${name}`,
    );
    packageRoots.set(name, packageRoot);
    const manifest = readJsonFile(
      path.join(packageRoot, "package.json"),
      `Pi Live production package ${name}`,
    );
    assert.deepEqual(
      [manifest.name, manifest.version],
      [name, version],
      `Pi Live production package identity differs: ${name}`,
    );
  }

  for (const name of [
    "@oh-my-pi/pi-natives-darwin-arm64",
    "https-proxy-agent",
    "proxy-from-env",
    "undici",
    "ws",
  ])
    assertLinkTo(
      path.join(nodeModules, ...name.split("/")),
      packageRoots.get(name)!,
      `Pi Live direct package link ${name}`,
    );
  for (const name of ["agent-base", "debug", "ms", "proxy-agent-negotiate"])
    assertLinkTo(
      path.join(virtualStore, "node_modules", name),
      packageRoots.get(name)!,
      `Pi Live hoisted package link ${name}`,
    );
  for (const [packageName, dependencies] of Object.entries(
    PI_LIVE_PRODUCTION_PACKAGE_LINKS,
  ))
    for (const dependency of dependencies)
      assertLinkTo(
        path.join(
          virtualStore,
          PI_LIVE_PRODUCTION_PACKAGES.find(
            ([, name]) => name === packageName,
          )![0],
          "node_modules",
          ...dependency.split("/"),
        ),
        packageRoots.get(dependency)!,
        `Pi Live ${packageName} dependency link ${dependency}`,
      );

  const modules = readJsonFile(
    path.join(nodeModules, ".modules.yaml"),
    "Pi Live pnpm modules record",
  );
  assert.equal(
    modules.packageManager,
    `pnpm@${PI_LIVE_PNPM_VERSION}`,
    "Pi Live install was not produced by the pinned pnpm",
  );
  assert.deepEqual(
    modules.included,
    {
      dependencies: true,
      devDependencies: false,
      optionalDependencies: true,
    },
    "Pi Live install is not the production dependency selection",
  );
  assert.deepEqual(
    modules.pendingBuilds,
    [],
    "Pi Live install has pending builds",
  );
  assert.deepEqual(modules.skipped, [], "Pi Live install skipped a package");
  const registries = jsonObject(
    modules.registries,
    "Pi Live pnpm registry record",
  );
  assert.equal(
    registries.default,
    PI_LIVE_PUBLIC_REGISTRY,
    "Pi Live install did not use the public npm registry",
  );

  const packageMap = readJsonFile(
    path.join(nodeModules, ".package-map.json"),
    "Pi Live pnpm package map",
  );
  const mappedPackages = jsonObject(
    packageMap.packages,
    "Pi Live pnpm mapped packages",
  );
  assertExactNames(
    Object.keys(mappedPackages),
    [".", ...packageIds.values()],
    "Pi Live pnpm mapped package",
  );
  const rootMapping = jsonObject(
    mappedPackages["."],
    "Pi Live pnpm root package mapping",
  );
  assert.equal(rootMapping.url, "..", "Pi Live pnpm root mapping differs");
  assert.deepEqual(
    rootMapping.dependencies,
    {
      "@oh-my-pi/pi-natives-darwin-arm64":
        "@oh-my-pi/pi-natives-darwin-arm64@17.2.9",
      "https-proxy-agent": "https-proxy-agent@9.1.0",
      "pi-live": ".",
      "proxy-from-env": "proxy-from-env@2.1.0",
      undici: "undici@8.10.0",
      ws: "ws@8.21.2",
    },
    "Pi Live pnpm direct package map differs",
  );
  for (const [folder, name, version] of PI_LIVE_PRODUCTION_PACKAGES) {
    const mapping = jsonObject(
      mappedPackages[`${name}@${version}`],
      `Pi Live pnpm package mapping ${name}`,
    );
    assert.equal(
      mapping.url,
      `./.pnpm/${folder}/node_modules/${name}`,
      `Pi Live pnpm package URL differs: ${name}`,
    );
    const dependencies: Record<string, string> = {
      [name]: `${name}@${version}`,
    };
    for (const dependency of PI_LIVE_PRODUCTION_PACKAGE_LINKS[name]!)
      dependencies[dependency] = packageIds.get(dependency)!;
    assert.deepEqual(
      mapping.dependencies,
      dependencies,
      `Pi Live pnpm package map topology differs: ${name}`,
    );
  }

  const workspace = readJsonFile(
    path.join(nodeModules, ".pnpm-workspace-state-v1.json"),
    "Pi Live pnpm workspace record",
  );
  const settings = jsonObject(
    workspace.settings,
    "Pi Live pnpm workspace settings",
  );
  assert.equal(
    settings.autoInstallPeers,
    false,
    "Pi Live install enabled automatic peers",
  );
  assert.equal(
    settings.dev,
    false,
    "Pi Live install contains development dependencies",
  );
  assert.equal(
    settings.production,
    true,
    "Pi Live install is not marked production",
  );
  assert.equal(
    settings.optional,
    true,
    "Pi Live install omitted the native optional dependency",
  );
  assert.equal(
    workspace.filteredInstall,
    false,
    "Pi Live install has an unexpected package filter",
  );

  const nativeRoot = path.join(
    nodeModules,
    "@oh-my-pi/pi-natives-darwin-arm64",
  );
  assertExactNames(
    fs.readdirSync(nativeRoot),
    ["README.md", "package.json", "pi_natives.darwin-arm64.node"],
    "Pi Live native package file",
  );
  assertHash(
    path.join(nativeRoot, "package.json"),
    PI_LIVE_NATIVE_MANIFEST_SHA256,
    "Pi Live native manifest",
  );
  assertHash(
    path.join(nativeRoot, "README.md"),
    PI_LIVE_NATIVE_README_SHA256,
    "Pi Live native README",
  );
  assertHash(
    path.join(nativeRoot, "pi_natives.darwin-arm64.node"),
    PI_LIVE_NATIVE_BINARY_SHA256,
    "Pi Live native binary",
  );
}
