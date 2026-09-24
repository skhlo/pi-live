import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
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

function check(directory: string) {
  return spawnSync(
    process.execPath,
    [path.join(directory, "scripts/check-transfer.ts")],
    {
      cwd: directory,
      encoding: "utf8",
      timeout: 30_000,
    },
  );
}

test("the extraction receipt verifies retained bytes without requiring private evidence", () => {
  const result = check(root);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /99|exact copies/);
  assert.match(result.stdout, /32 archived originals/);
  assert.match(result.stdout, /29 private captures not checked/);
});

test("the extraction receipt rejects one-byte drift in an exact copied artifact", (t) => {
  const fixture = mkdtempSync(path.join(tmpdir(), "pi-live-transfer-test-"));
  t.after(() => rmSync(fixture, { recursive: true }));
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
  const destinations = [receiptPath, "scripts/check-transfer.ts"];
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
  for (const relative of destinations) {
    const target = path.join(fixture, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(path.join(root, relative), target);
  }
  const initial = check(fixture);
  assert.equal(initial.status, 0, initial.stderr);
  const license = path.join(fixture, "LICENSE");
  writeFileSync(
    license,
    Buffer.concat([readFileSync(license), Buffer.from("x")]),
  );
  const mutated = check(fixture);
  assert.equal(mutated.status, 1, mutated.stdout);
  assert.match(mutated.stderr, /Transfer bytes differ: LICENSE/);
});
