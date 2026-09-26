import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const receiptPath = "docs/history/extraction/transfer-receipt.json";
const historicalCommit = "f421dad09d376c02482924170d3796e516670021";

const localGitEnvironment = {
  ...process.env,
  GIT_NO_LAZY_FETCH: "1",
  GIT_TERMINAL_PROMPT: "0",
};

function localGit(args: string[]) {
  return spawnSync("git", ["--no-lazy-fetch", "-C", root, ...args], {
    encoding: "utf8",
    env: localGitEnvironment,
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function localGitBlob(object: string) {
  return spawnSync(
    "git",
    ["--no-lazy-fetch", "-C", root, "cat-file", "blob", object],
    {
      env: localGitEnvironment,
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
}

function repositoryCustodyPaths(): string[] {
  const parsed: unknown = JSON.parse(
    readFileSync(path.join(root, receiptPath), "utf8"),
  );
  assert.ok(
    parsed &&
      typeof parsed === "object" &&
      "files" in parsed &&
      "research" in parsed,
  );
  assert.ok(Array.isArray(parsed.files) && Array.isArray(parsed.research));
  const destinations: string[] = [];
  for (const value of parsed.files) {
    assert.ok(value && typeof value === "object" && "destination" in value);
    assert.equal(typeof value.destination, "string");
    destinations.push(value.destination as string);
  }
  for (const value of parsed.research) {
    assert.ok(
      value &&
        typeof value === "object" &&
        "custody" in value &&
        "destination" in value,
    );
    if (value.custody === "repository") {
      assert.equal(typeof value.destination, "string");
      destinations.push(value.destination as string);
    }
  }
  assert.equal(destinations.length, 131);
  assert.equal(new Set(destinations).size, 131);
  return destinations;
}

function materializeHistoricalSnapshot(directory: string): void {
  const commit = localGit(["cat-file", "-e", `${historicalCommit}^{commit}`]);
  assert.ifError(commit.error);
  assert.equal(
    commit.status,
    0,
    `Historical transfer prerequisite missing: local Git commit ${historicalCommit} and its blobs must be present; network fetch is disabled.\n${String(commit.stderr)}`,
  );

  const tree = localGit([
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    historicalCommit,
  ]);
  assert.ifError(tree.error);
  assert.equal(
    tree.status,
    0,
    `Historical transfer prerequisite missing: local metadata for ${historicalCommit} is unavailable; network fetch is disabled.\n${String(tree.stderr)}`,
  );
  assert.equal(typeof tree.stdout, "string");
  const entries = new Map<string, { mode: string; object: string }>();
  for (const record of tree.stdout.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    assert.notEqual(tab, -1, `Malformed Git tree record: ${record}`);
    const metadata = record.slice(0, tab).split(" ");
    assert.equal(metadata.length, 3, `Malformed Git tree metadata: ${record}`);
    const [mode, type, object] = metadata;
    if (type === "blob") entries.set(record.slice(tab + 1), { mode, object });
  }

  for (const relative of repositoryCustodyPaths()) {
    const entry = entries.get(relative);
    assert.ok(
      entry,
      `Historical transfer prerequisite missing: ${relative} is absent from local commit ${historicalCommit}`,
    );
    assert.equal(
      entry.mode,
      "100644",
      `Unexpected historical mode: ${relative}`,
    );
    const blob = localGitBlob(entry.object);
    assert.ifError(blob.error);
    assert.equal(
      blob.status,
      0,
      `Historical transfer prerequisite missing: local blob ${entry.object} for ${relative} is unavailable; network fetch is disabled.\n${String(blob.stderr)}`,
    );
    assert.ok(Buffer.isBuffer(blob.stdout));
    const target = path.join(directory, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, blob.stdout, { mode: 0o644 });
    chmodSync(target, 0o644);
  }
}

function check(args: string[] = []) {
  return spawnSync(
    process.execPath,
    [path.join(root, "scripts/check-transfer.ts"), ...args],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
    },
  );
}

function checkSnapshot(directory: string) {
  return check(["--root", directory]);
}

test("the historical extraction snapshot verifies without requiring private evidence", (t) => {
  const fixture = mkdtempSync(path.join(tmpdir(), "pi-live-transfer-test-"));
  t.after(() => rmSync(fixture, { recursive: true }));
  materializeHistoricalSnapshot(fixture);

  const result = checkSnapshot(fixture);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /99|exact copies/);
  assert.match(result.stdout, /32 archived originals/);
  assert.match(result.stdout, /29 private captures not checked/);
});

test("the extraction receipt rejects one-byte drift in an exact copied artifact", (t) => {
  const fixture = mkdtempSync(path.join(tmpdir(), "pi-live-transfer-test-"));
  t.after(() => rmSync(fixture, { recursive: true }));
  materializeHistoricalSnapshot(fixture);

  const initial = checkSnapshot(fixture);
  assert.equal(initial.status, 0, initial.stderr);
  const license = path.join(fixture, "LICENSE");
  const changed = readFileSync(license);
  assert.ok(changed.length > 0);
  changed[0] ^= 1;
  writeFileSync(license, changed);

  const mutated = checkSnapshot(fixture);
  assert.equal(mutated.status, 1, mutated.stdout);
  assert.match(mutated.stderr, /Transfer bytes differ: LICENSE/);
});

test("the snapshot root also verifies archived research bytes", (t) => {
  const fixture = mkdtempSync(path.join(tmpdir(), "pi-live-transfer-test-"));
  t.after(() => rmSync(fixture, { recursive: true }));
  materializeHistoricalSnapshot(fixture);

  const relative = "docs/history/extraction/original/FEASIBILITY.md";
  const archive = path.join(fixture, relative);
  const changed = readFileSync(archive);
  assert.ok(changed.length > 0);
  changed[0] ^= 1;
  writeFileSync(archive, changed);

  const result = checkSnapshot(fixture);
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    result.stderr,
    /Transfer bytes differ: docs\/history\/extraction\/original\/FEASIBILITY\.md/,
  );
});

test("a receipt inside the snapshot cannot bless a changed license", (t) => {
  const fixture = mkdtempSync(path.join(tmpdir(), "pi-live-transfer-test-"));
  t.after(() => rmSync(fixture, { recursive: true }));
  materializeHistoricalSnapshot(fixture);

  const license = path.join(fixture, "LICENSE");
  const changed = readFileSync(license);
  assert.ok(changed.length > 0);
  changed[0] ^= 1;
  writeFileSync(license, changed);
  const changedHash = createHash("sha256").update(changed).digest("hex");

  const forged: unknown = JSON.parse(
    readFileSync(path.join(root, receiptPath), "utf8"),
  );
  assert.ok(forged && typeof forged === "object" && "files" in forged);
  assert.ok(Array.isArray(forged.files));
  const licenseEntry = forged.files.find(
    (value: unknown) =>
      value !== null &&
      typeof value === "object" &&
      "destination" in value &&
      value.destination === "LICENSE",
  );
  assert.ok(licenseEntry && typeof licenseEntry === "object");
  Object.assign(licenseEntry, {
    sourceSha256: changedHash,
    destinationSha256: changedHash,
  });
  const fixtureReceipt = path.join(fixture, receiptPath);
  mkdirSync(path.dirname(fixtureReceipt), { recursive: true });
  writeFileSync(fixtureReceipt, `${JSON.stringify(forged, null, 2)}\n`);

  const result = checkSnapshot(fixture);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /Transfer bytes differ: LICENSE/);
});

test("a developed current-like tree is rejected as the initial snapshot", (t) => {
  const fixture = mkdtempSync(path.join(tmpdir(), "pi-live-transfer-test-"));
  t.after(() => rmSync(fixture, { recursive: true }));
  materializeHistoricalSnapshot(fixture);

  const developed = Buffer.concat([
    readFileSync(path.join(root, "src/live.ts")),
    Buffer.from(
      "\n// Deliberate post-extraction call-lifecycle development.\n",
    ),
  ]);
  writeFileSync(path.join(fixture, "src/live.ts"), developed);

  const result = checkSnapshot(fixture);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /Transfer bytes differ: src\/live\.ts/);
});

test("the default transfer check rejects the developed working tree", () => {
  const result = check();
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stdout);
  // The first developed file it meets is reported; package.json now precedes
  // src/live.ts since the v0.1.0 version and description change.
  assert.match(result.stderr, /Transfer bytes differ: \S+/);
});

test("the transfer checker rejects invalid CLI arguments", () => {
  const cases: Array<{ args: string[]; message: RegExp }> = [
    { args: ["--root"], message: /argument missing/ },
    { args: ["--root="], message: /Snapshot root must not be empty/ },
    { args: ["--unknown"], message: /Unknown option '--unknown'/ },
    { args: ["unexpected"], message: /Unexpected argument 'unexpected'/ },
    {
      args: ["--root", path.join(root, "LICENSE")],
      message: /Snapshot root is not a directory/,
    },
  ];

  for (const { args, message } of cases) {
    const result = check(args);
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /Transfer check failed:/);
    assert.match(result.stderr, message);
  }
});
