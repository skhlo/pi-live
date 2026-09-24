import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { linkSync, renameSync, unlinkSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

const SOURCE_COMMIT = "39171682343754366439b2c0890f5b0f4c3ed891";
const SOURCE_TREE = "3aea19fabc79a2ec8f00469edc97b668b246ec94";
const SNAPSHOT_FILE_MODE = 0o644;
const LOCK_FILE_MODE = 0o644;

function withPinnedModes<
  const Records extends Record<
    string,
    { gitBlobSha1: string; sha256: string; role: string }
  >,
>(
  records: Records,
): {
  [Name in keyof Records]: Records[Name] & { mode: "100644" };
} {
  return Object.fromEntries(
    Object.entries(records).map(([name, record]) => [
      name,
      { ...record, mode: "100644" as const },
    ]),
  ) as { [Name in keyof Records]: Records[Name] & { mode: "100644" } };
}

const fileRecords = withPinnedModes({
  LICENSE: {
    gitBlobSha1: "14fac913ccf80234b1848540089a3bbcb6e5283d",
    sha256: "1126322e2cc8d165adc4c792eeb195717de2bcc7b39be1ce77959d78e87ef685",
    role: "license",
  },
  "THIRD_PARTY_NOTICES.md": {
    gitBlobSha1: "5fa1cc86c8658d0508ff63ce3b168279d4a173c5",
    sha256: "58f8d237355fafb7832f9ad4e418aacd248223fd7818c36c00111da48caa279a",
    role: "notice",
  },
  "package.json": {
    gitBlobSha1: "662723354acf97ac8b51e6c2eb3b91dcd3e5d71b",
    sha256: "fb4f4a7b4e302bafd614da3c2c15c5499c8799e074c8765931b84edb4a5dd440",
    role: "manifest",
  },
  "src/codex-auth.ts": {
    gitBlobSha1: "02427650080434e413ff343bb87ac939d054a80f",
    sha256: "f87effd043dc7e8722be4e36866d5fee32a8e9bba23ac0d3f788932eb370989e",
    role: "ideas-only",
  },
  "src/format.ts": {
    gitBlobSha1: "9ac077696a50fd003f080e77669e853cce4366e8",
    sha256: "c3c9ed1db3a6cb8503cf69d7505d22cc5883f6e33aabff90d8a6cec8e912ca44",
    role: "ideas-only",
  },
  "src/paths.ts": {
    gitBlobSha1: "26c8b29d375bae1f4bef74c475de5d678870b1fd",
    sha256: "8528aaec2f3b2278d516ee286dbc3805a30ef6a4b72ad23b6b0c292589ae2c72",
    role: "ideas-only",
  },
  "src/live/attestation.ts": {
    gitBlobSha1: "d7d32eca25bade27134cb717ad2eac2ab7029dbd",
    sha256: "3ed2019a00207c5547e6fbe4f31b20ac93e34523e99ba0fb78c863e76b85edbb",
    role: "adaptation-source",
  },
  "src/live/controller.ts": {
    gitBlobSha1: "0ef7db4b8fa0dbf22dddd6abf6e48648047c0fca",
    sha256: "2a556fd6ab0b180638d985edbc5f481fc1928c7ff0b90184efe42516a981f0c2",
    role: "adaptation-source",
  },
  "src/live/focus.ts": {
    gitBlobSha1: "518d56cf528f2bde0d7dd09667b07f5d18c4fecd",
    sha256: "113943933134f45c364ef6c99685865b7abea1fce31285a479682ea54a670cbc",
    role: "provenance-only",
  },
  "src/live/index.ts": {
    gitBlobSha1: "50c570eae9dd6c466976456ee4bee99aea2f7d27",
    sha256: "680ffb60ba8ed876086225075557a24c21338d67c5dbc323d81386f8babb6564",
    role: "adaptation-source",
  },
  "src/live/native.ts": {
    gitBlobSha1: "10f38324a72122e3ac8fe2499b0ea9cc933b724b",
    sha256: "147b082066ca103ae5abf70b5e4f0fbd0c22696f206e55e41035a1dcbe854b54",
    role: "adaptation-source",
  },
  "src/live/protocol.ts": {
    gitBlobSha1: "f0983ee7d2d0ffd4d617fa3769af6c0df3d23b89",
    sha256: "563b00d6bf9e78e098d901c4abab2054929b999030e98014d9f541c52b3f4bfe",
    role: "adaptation-source",
  },
  "src/live/queue.ts": {
    gitBlobSha1: "e349fb02db04283df731140e55bab501ca4a4342",
    sha256: "f414227c50fcfc86d2afd0ce95a087df72f37359b5e332c76c78da4cf68ae0f2",
    role: "provenance-only",
  },
  "src/live/transport.ts": {
    gitBlobSha1: "81e9d2920b106dfc089b2c42447d66554afe268d",
    sha256: "b951dab46d776444fae54f15f042ed78fc5a81ab88fd99f27d2bae78c5f4bc9f",
    role: "adaptation-source",
  },
  "src/live/visualizer.ts": {
    gitBlobSha1: "072ffddad165b2433d4c6e9753d5d87f41122d2b",
    sha256: "b4039c73977d691c67af05e5930b50b5745e2e146a2a8961f5f5289ca7256afa",
    role: "adaptation-source",
  },
  "src/live/voices.ts": {
    gitBlobSha1: "8f827cecd9d3ce05a797f026f1cc1999ea672539",
    sha256: "5fa1da362e46ee3955a3d9f8b96fe40d8e14e4aa7939d10314a2190d249f12b6",
    role: "adaptation-source",
  },
  "tests/live-controller.test.ts": {
    gitBlobSha1: "72d5f686f4ba9219be81231ad4f53c28af2427d8",
    sha256: "62d6bb78767cbbd4f558349e99e34807fd535b4b18d0ec5d8bcf2682771f56b0",
    role: "upstream-test",
  },
  "tests/live-focus.test.ts": {
    gitBlobSha1: "6f3dbd7788c8d4ac595a3ca2c7974a7e479ed5dd",
    sha256: "76f3853dcb16edc8fe86b0d34214d539b40779519f94d462c74e5bed3caf58cc",
    role: "provenance-only",
  },
  "tests/live-native.test.ts": {
    gitBlobSha1: "2010cc3d8f51393bb2e849941b66eb3ba57ae7f7",
    sha256: "0e895ace7d6485a95c45ab3cb62d1dc14b762114a14c3a98774b36c1873f7667",
    role: "upstream-test",
  },
  "tests/live-protocol.test.ts": {
    gitBlobSha1: "dffe836a8daf8cc4dbf22590439045dfa960f65d",
    sha256: "e567b2d32d67c7d42d44a145100031672af185cae4a67f4f8ba7a5ec6a18ead3",
    role: "upstream-test",
  },
  "tests/live-queue.test.ts": {
    gitBlobSha1: "399621a6e8f8fec6e4e744b570b77f24de4c7fd4",
    sha256: "f32bfdd82cf720437a8f13c7c6745c354dd06ea115b313e9d54ad217cfd8cbf3",
    role: "provenance-only",
  },
  "tests/live-registration.test.ts": {
    gitBlobSha1: "affec6a96d177a65760c940bee77198d3d7e6b70",
    sha256: "1169b20274950219d684c7c77b2a88398820b5e18c1444b9141a0f3cbb965167",
    role: "upstream-test",
  },
  "tests/live-transport.test.ts": {
    gitBlobSha1: "33beaffa4ec465ec5ac7839e7e4e2d893a353114",
    sha256: "86516a9a34130c80b4d5554112af671bc0d7f0160971a04bdcecf2aa20076595",
    role: "upstream-test",
  },
  "tests/live-visualizer.test.ts": {
    gitBlobSha1: "04382b127706ec35f36ac9ace9cf9121507064aa",
    sha256: "d3672ed51cb256ca1be3765e973aab29ff3aa19c987df0c60c58c88e29675c5b",
    role: "upstream-test",
  },
} as const);

const expectedLock = {
  schemaVersion: 1,
  snapshot: {
    purpose:
      "Exact selected upstream provenance for the private pi-live extraction.",
    pathMapping: "Original paths are preserved beneath upstream/pi-live/.",
    runtimeLoaded: false,
  },
  source: {
    repository: "https://github.com/monotykamary/pi-better-openai",
    commit: SOURCE_COMMIT,
    tree: SOURCE_TREE,
    version: "0.2.6",
    license: "MIT",
  },
  files: fileRecords,
  nativeReceipt: {
    package: "@oh-my-pi/pi-natives-darwin-arm64",
    version: "17.2.9",
    platform: { os: "darwin", cpu: "arm64" },
    tarball: {
      url: "https://registry.npmjs.org/@oh-my-pi/pi-natives-darwin-arm64/-/pi-natives-darwin-arm64-17.2.9.tgz",
      integrity:
        "sha512-9Fmi4mXtybtKJ8WiVUMjhuVOFQOIHeE8wmxACT9h+OS/17UYC/xvYPWcGtUqbqI7RUIOqJl9gJxY8G7lsLNLug==",
      sha256:
        "f9df6f01bd00a3a9f685cd87341b691699b409906767f8c75a0eb53b516cc7da",
      bytes: 26761088,
      members: {
        "package/package.json": {
          sha256:
            "9e985ae0ee2cd229326f9d1fed99ca0341a324720c96fcc2e123eaea4f97a44e",
          bytes: 389,
        },
        "package/README.md": {
          sha256:
            "ee2db3b14282526ae7333398352640afd2f7a84b0c96d43e1eb97340e930498b",
          bytes: 214,
        },
        "package/pi_natives.darwin-arm64.node": {
          sha256:
            "35bbb69631c88b2691941a1df660eac3416e43cbef6ed0309a4742defde51cf4",
          bytes: 144799744,
        },
      },
    },
    source: {
      repository: "https://github.com/can1357/oh-my-pi",
      commit: "f7f8e040ee04710414fbd775431091fa301b9786",
      tag: "v17.2.9",
      workflow: {
        path: ".github/workflows/ci.yml",
        runId: 30965471779,
        attempt: 1,
        conclusion: "success",
        buildJobId: 92178406852,
        publishJobId: 92181848147,
      },
      correspondence:
        "Publisher-attested npm tarball provenance; not an independently reproduced build.",
    },
    disposition: {
      acceptedByOperatorOn: "2026-09-24",
      scope: ["personal-use", "open-source-use"],
      legalClearanceClaimed: false,
      residualsAccepted: [
        "The release Actions addon artifact expired, so no direct archived build-output byte comparison was possible.",
        "The Fulcio/Rekor chain was not independently verified beyond the recorded publisher attestation checks.",
        "A complete target-specific compiled-code notice inventory is unavailable, including objc2/Apple generated-binding uncertainty, historical attribution qualifications, and remaining dependency/resource notice gaps.",
      ],
      distribution: {
        provisionFromPinnedNpmTarball: true,
        commitBinary: false,
        commitTarball: false,
        mirrorOrRepublish: false,
      },
      reviewTriggers: [
        "native-source-change",
        "native-pin-change",
        "distribution-model-change",
        "repository-visibility-change",
      ],
    },
  },
};

const expectedLockBytes = Buffer.from(
  `${JSON.stringify(expectedLock, null, 2)}\n`,
);
const selectedPaths = Object.keys(fileRecords).sort();
const expectedDirectories = new Set([".", "src", "src/live", "tests"]);
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const snapshotRoot = path.join(repositoryRoot, "upstream/pi-live");
const lockPath = path.join(repositoryRoot, "upstream/pi-live.lock.json");

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function gitBlobSha1(bytes: Uint8Array): string {
  return createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");
}

async function collectSnapshot(
  directory: string,
  relative = ".",
  files: string[] = [],
  directories: string[] = [],
): Promise<{ files: string[]; directories: string[] }> {
  const info = await lstat(directory);
  if (info.isSymbolicLink())
    throw new Error(`Snapshot symlink is forbidden: ${relative}`);
  if (!info.isDirectory())
    throw new Error(`Snapshot directory is not a directory: ${relative}`);
  directories.push(relative);
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const childRelative =
      relative === "." ? entry.name : `${relative}/${entry.name}`;
    const child = path.join(directory, entry.name);
    const childInfo = await lstat(child);
    if (childInfo.isSymbolicLink())
      throw new Error(`Snapshot symlink is forbidden: ${childRelative}`);
    if (childInfo.isDirectory()) {
      await collectSnapshot(child, childRelative, files, directories);
    } else if (childInfo.isFile()) {
      if ((childInfo.mode & 0o777) !== SNAPSHOT_FILE_MODE)
        throw new Error(`Snapshot file mode must be 0644: ${childRelative}`);
      files.push(childRelative);
    } else {
      throw new Error(`Snapshot special file is forbidden: ${childRelative}`);
    }
  }
  return { files, directories };
}

function assertExactNames(
  actual: Iterable<string>,
  expected: Iterable<string>,
  label: string,
): void {
  const actualNames = [...actual].sort();
  const expectedNames = [...expected].sort();
  const missing = expectedNames.filter((name) => !actualNames.includes(name));
  const extra = actualNames.filter((name) => !expectedNames.includes(name));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `${label} inventory mismatch (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"})`,
    );
  }
}

async function verifyLock(candidateLock: string): Promise<void> {
  const lockInfo = await lstat(candidateLock);
  if (lockInfo.isSymbolicLink() || !lockInfo.isFile())
    throw new Error(
      "pi-live lock must be a regular file, not a symlink or special file",
    );
  if ((lockInfo.mode & 0o777) !== LOCK_FILE_MODE)
    throw new Error("pi-live lock mode must be 0644");
  const actualLock = await readFile(candidateLock);
  if (!actualLock.equals(expectedLockBytes))
    throw new Error(
      "pi-live lock fields differ from the immutable pinned receipt",
    );
}

async function verifySnapshotFiles(candidateSnapshot: string): Promise<void> {
  const inventory = await collectSnapshot(candidateSnapshot);
  assertExactNames(inventory.files, selectedPaths, "Snapshot file");
  assertExactNames(
    inventory.directories,
    expectedDirectories,
    "Snapshot directory",
  );
  for (const selectedPath of selectedPaths) {
    const bytes = await readFile(path.join(candidateSnapshot, selectedPath));
    const expected = fileRecords[selectedPath as keyof typeof fileRecords];
    if (sha256(bytes) !== expected.sha256)
      throw new Error(`Pinned SHA-256 mismatch: ${selectedPath}`);
    if (gitBlobSha1(bytes) !== expected.gitBlobSha1)
      throw new Error(`Pinned Git blob mismatch: ${selectedPath}`);
  }
}

async function verifySnapshot(): Promise<void> {
  await verifyLock(lockPath);
  await verifySnapshotFiles(snapshotRoot);
}

type GitEntry = {
  mode: string;
  type: string;
  sha: string;
  path: string;
};

function git(source: string, args: string[]): Buffer {
  const result = spawnSync("git", ["-C", source, ...args], {
    encoding: null,
    env: {
      ...process.env,
      GIT_NO_LAZY_FETCH: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
    maxBuffer: 5_000_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = Buffer.from(result.stderr ?? [])
      .toString("utf8")
      .trim();
    throw new Error(`Git object read failed${detail ? `: ${detail}` : ""}`);
  }
  return Buffer.from(result.stdout ?? []);
}

function parseTree(bytes: Buffer, prefix = ""): GitEntry[] {
  const entries: GitEntry[] = [];
  for (const record of bytes.toString("utf8").split("\0")) {
    if (!record) continue;
    const match = /^(\d{6}) (\S+) ([a-f0-9]{40})\t(.+)$/.exec(record);
    if (!match) throw new Error("Unexpected pinned Git tree record");
    entries.push({
      mode: match[1]!,
      type: match[2]!,
      sha: match[3]!,
      path: `${prefix}${match[4]!}`,
    });
  }
  return entries;
}

async function verifySource(
  sourceArgument: string,
): Promise<Map<string, Buffer>> {
  const source = path.resolve(sourceArgument);
  const sourceInfo = await lstat(source);
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory())
    throw new Error(
      "Source repository must be a regular directory, not a symlink",
    );

  const commit = git(source, [
    "rev-parse",
    "--verify",
    `${SOURCE_COMMIT}^{commit}`,
  ])
    .toString("utf8")
    .trim();
  if (commit !== SOURCE_COMMIT)
    throw new Error(`Source repository lacks pinned commit ${SOURCE_COMMIT}`);

  const tree = git(source, ["rev-parse", "--verify", `${SOURCE_COMMIT}^{tree}`])
    .toString("utf8")
    .trim();
  if (tree !== SOURCE_TREE)
    throw new Error(`Pinned source tree mismatch: expected ${SOURCE_TREE}`);

  const explicit = selectedPaths.filter(
    (name) => !name.startsWith("src/live/") && !name.startsWith("tests/live-"),
  );
  const entries = [
    ...parseTree(
      git(source, ["ls-tree", "-z", SOURCE_COMMIT, "--", ...explicit]),
    ),
    ...parseTree(
      git(source, ["ls-tree", "-z", `${SOURCE_COMMIT}:src/live`]),
      "src/live/",
    ),
    ...parseTree(
      git(source, ["ls-tree", "-z", `${SOURCE_COMMIT}:tests`]),
      "tests/",
    ).filter((entry) => /^tests\/live-.*\.test\.ts$/.test(entry.path)),
  ];
  assertExactNames(
    entries.map((entry) => entry.path),
    selectedPaths,
    "Pinned source",
  );

  const result = new Map<string, Buffer>();
  for (const entry of entries) {
    const expected = fileRecords[entry.path as keyof typeof fileRecords];
    if (entry.mode !== expected.mode || entry.type !== "blob")
      throw new Error(
        `Pinned source entry mode or type differs: ${entry.path}`,
      );
    if (entry.sha !== expected.gitBlobSha1)
      throw new Error(`Pinned Git tree mismatch: ${entry.path}`);
    const bytes = git(source, ["cat-file", "blob", entry.sha]);
    if (
      gitBlobSha1(bytes) !== expected.gitBlobSha1 ||
      sha256(bytes) !== expected.sha256
    )
      throw new Error(`Pinned Git object mismatch: ${entry.path}`);
    result.set(entry.path, bytes);
  }
  return result;
}

type DirectoryIdentity = { dev: bigint; ino: bigint };

function directoryIdentity(info: {
  dev: bigint;
  ino: bigint;
}): DirectoryIdentity {
  return { dev: info.dev, ino: info.ino };
}

async function assertDirectoryIdentity(
  directory: string,
  expected: DirectoryIdentity,
): Promise<void> {
  const info = await lstat(directory, { bigint: true });
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    info.dev !== expected.dev ||
    info.ino !== expected.ino
  )
    throw new Error("upstream directory identity changed during import");
}

async function writePinnedFile(
  destination: string,
  bytes: Uint8Array,
  mode: number,
): Promise<void> {
  await writeFile(destination, bytes, { flag: "wx", mode });
  await chmod(destination, mode);
  const handle = await open(destination, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function stageSnapshot(
  temporaryRoot: string,
  files: Map<string, Buffer>,
): Promise<{ snapshot: string; lock: string }> {
  const snapshot = path.join(temporaryRoot, "pi-live");
  const lock = path.join(temporaryRoot, "pi-live.lock.json");
  await mkdir(snapshot);
  await mkdir(path.join(snapshot, "src"));
  await mkdir(path.join(snapshot, "src/live"));
  await mkdir(path.join(snapshot, "tests"));
  for (const selectedPath of selectedPaths) {
    const bytes = files.get(selectedPath);
    if (!bytes)
      throw new Error(`Missing verified source bytes: ${selectedPath}`);
    await writePinnedFile(
      path.join(snapshot, selectedPath),
      bytes,
      SNAPSHOT_FILE_MODE,
    );
  }
  await writePinnedFile(lock, expectedLockBytes, LOCK_FILE_MODE);
  await verifySnapshotFiles(snapshot);
  await verifyLock(lock);
  for (const directory of [
    path.join(snapshot, "src/live"),
    path.join(snapshot, "src"),
    path.join(snapshot, "tests"),
    snapshot,
    temporaryRoot,
  ])
    await syncDirectory(directory);
  return { snapshot, lock };
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertAbsentForPublication(destination: string): Promise<void> {
  if (await exists(destination))
    throw new Error(
      `Refusing to overwrite existing pi-live snapshot: ${destination} appeared during import`,
    );
}

async function importSnapshot(
  source: string,
): Promise<"imported" | "existing"> {
  const files = await verifySource(source);
  const destinationExists = await exists(snapshotRoot);
  const lockExists = await exists(lockPath);
  try {
    if (destinationExists) await verifySnapshotFiles(snapshotRoot);
    if (lockExists) await verifyLock(lockPath);
  } catch (error) {
    throw new Error(
      `Refusing to overwrite existing pi-live snapshot: ${message(error)}`,
    );
  }
  if (destinationExists && lockExists) return "existing";

  const upstream = path.dirname(snapshotRoot);
  const upstreamInfo = await lstat(upstream, { bigint: true });
  if (upstreamInfo.isSymbolicLink() || !upstreamInfo.isDirectory())
    throw new Error("upstream must be a regular directory, not a symlink");
  const expectedUpstream = directoryIdentity(upstreamInfo);
  const temporaryRoot = await mkdtemp(path.join(upstream, ".pi-live.import-"));
  try {
    const staged = await stageSnapshot(temporaryRoot, files);
    await assertDirectoryIdentity(upstream, expectedUpstream);
    if (destinationExists) await verifySnapshotFiles(snapshotRoot);
    else {
      await assertAbsentForPublication(snapshotRoot);
      renameSync(staged.snapshot, snapshotRoot);
      await syncDirectory(upstream);
    }

    await assertDirectoryIdentity(upstream, expectedUpstream);
    if (lockExists) await verifyLock(lockPath);
    else {
      await assertAbsentForPublication(lockPath);
      linkSync(staged.lock, lockPath);
      unlinkSync(staged.lock);
      await syncDirectory(upstream);
    }
    await verifySnapshot();
    return "imported";
  } finally {
    await rm(temporaryRoot, { recursive: true });
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    strict: true,
    options: { source: { type: "string" } },
  });
  if (
    positionals.length !== 1 ||
    !["check", "import"].includes(positionals[0]!)
  )
    throw new Error(
      "Usage: node scripts/import-pi-live.ts check [--source <repo>] | import --source <repo>",
    );
  const command = positionals[0]!;
  if (command === "import") {
    if (!values.source)
      throw new Error("import requires an explicit --source <repo>");
    const outcome = await importSnapshot(values.source);
    console.log(
      `${outcome === "imported" ? "Imported" : "Verified existing"} pi-live ${SOURCE_COMMIT}: ${selectedPaths.length} pinned files.`,
    );
    return;
  }

  await verifySnapshot();
  if (values.source) await verifySource(values.source);
  console.log(
    `Verified pi-live ${SOURCE_COMMIT}: ${selectedPaths.length} pinned files.`,
  );
}

main().catch((error: unknown) => {
  console.error(`pi-live import/check failed: ${message(error)}`);
  process.exitCode = 1;
});
