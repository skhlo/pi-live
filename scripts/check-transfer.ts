import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const root = path.resolve(import.meta.dirname, "..");
const receiptPath = "docs/history/extraction/transfer-receipt.json";

function object(value: unknown): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  assert.equal(typeof value, "string");
  return value as string;
}

function relativePath(value: unknown): string {
  const relative = text(value);
  assert.ok(relative.length > 0 && !relative.includes("\\"));
  assert.ok(!path.posix.isAbsolute(relative));
  assert.equal(path.posix.normalize(relative), relative);
  assert.ok(relative.split("/").every((part) => part !== "." && part !== ".."));
  return relative;
}

function sha256(value: unknown): string {
  const hash = text(value);
  assert.match(hash, /^[0-9a-f]{64}$/);
  return hash;
}

function verifyFile(
  base: string,
  relative: string,
  expected: string,
  mode: unknown,
): void {
  const file = path.join(base, relative);
  const info = lstatSync(file);
  assert.ok(
    info.isFile() && !info.isSymbolicLink(),
    `Not a regular file: ${relative}`,
  );
  assert.equal(realpathSync(file), file, `Redirected path: ${relative}`);
  assert.equal(info.mode & 0o777, mode, `File mode differs: ${relative}`);
  assert.equal(
    createHash("sha256").update(readFileSync(file)).digest("hex"),
    expected,
    `Transfer bytes differ: ${relative}`,
  );
}

function main(): void {
  const { values } = parseArgs({
    options: {
      root: { type: "string" },
      "private-evidence": { type: "string" },
    },
  });
  const repository = realpathSync(root);
  assert.notEqual(values.root, "", "Snapshot root must not be empty");
  const snapshot =
    values.root === undefined ? repository : realpathSync(values.root);
  assert.ok(
    lstatSync(snapshot).isDirectory(),
    "Snapshot root is not a directory",
  );
  const parsed: unknown = JSON.parse(
    readFileSync(path.join(repository, receiptPath), "utf8"),
  );
  const receipt = object(parsed);
  assert.equal(receipt.schemaVersion, 1);
  const source = object(receipt.source);
  assert.equal(source.repository, "https://github.com/skhlo/dotfiles");
  assert.equal(source.commit, "db2c57f13c274d66d79287fda8de177c016f0c02");
  assert.ok(Array.isArray(receipt.files));
  assert.equal(
    receipt.files.length,
    99,
    "Extraction must account for all 99 selected source files",
  );
  const destinations = new Set<string>();
  let exact = 0;
  let adapted = 0;
  for (const value of receipt.files) {
    const entry = object(value);
    relativePath(entry.source);
    const destination = relativePath(entry.destination);
    assert.ok(
      !destinations.has(destination),
      `Duplicate destination: ${destination}`,
    );
    destinations.add(destination);
    const original = sha256(entry.sourceSha256);
    const extracted = sha256(entry.destinationSha256);
    assert.equal(entry.mode, 0o644);
    if (entry.treatment === "exact") {
      assert.equal(
        extracted,
        original,
        `Exact-copy hash differs: ${destination}`,
      );
      exact += 1;
    } else {
      assert.equal(entry.treatment, "adapted");
      assert.ok(text(entry.reason).trim().length > 0);
      adapted += 1;
    }
    verifyFile(snapshot, destination, extracted, entry.mode);
  }
  assert.ok(Array.isArray(receipt.research));
  assert.equal(
    receipt.research.length,
    61,
    "Research custody must account for all 61 files",
  );
  const researchSources = new Set<string>();
  let archived = 0;
  let privateCount = 0;
  const privateRoot = values["private-evidence"]
    ? realpathSync(values["private-evidence"])
    : undefined;
  for (const value of receipt.research) {
    const entry = object(value);
    const original = relativePath(entry.source);
    assert.ok(
      !researchSources.has(original),
      `Duplicate research source: ${original}`,
    );
    researchSources.add(original);
    const expected = sha256(entry.sha256);
    const destination = relativePath(entry.destination);
    assert.ok(text(entry.reason).trim().length > 0);
    if (entry.custody === "repository") {
      assert.ok(destination.startsWith("docs/history/extraction/original/"));
      assert.ok(
        !destinations.has(destination),
        `Duplicate destination: ${destination}`,
      );
      destinations.add(destination);
      assert.equal(entry.mode, 0o644);
      verifyFile(snapshot, destination, expected, entry.mode);
      archived += 1;
    } else {
      assert.equal(entry.custody, "private-local");
      assert.equal(entry.mode, 0o600);
      if (privateRoot)
        verifyFile(privateRoot, destination, expected, entry.mode);
      privateCount += 1;
    }
  }
  console.log(
    `Verified initial extraction: ${exact} exact copies, ${adapted} declared adaptations, ${archived} archived originals; ${privateCount} private captures ${privateRoot ? "verified" : "not checked (use --private-evidence with the local custody directory)"}.`,
  );
}

try {
  main();
} catch (error: unknown) {
  console.error(
    `Transfer check failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
