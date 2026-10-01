import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  inspectPiLivePackagePayload,
  PI_LIVE_FULL_LOCK_SHA256,
  PI_LIVE_NATIVE_BINARY_SHA256,
  PI_LIVE_NATIVE_MANIFEST_SHA256,
  PI_LIVE_NATIVE_README_SHA256,
  PI_LIVE_NOTICE_FILE_COUNT,
  PI_LIVE_NOTICE_MANIFEST_SHA256,
  PI_LIVE_PRODUCTION_LOCK_SHA256,
  piLiveSha256,
} from "./pi-live-package.ts";

const LICENSE_SHA256 =
  "1126322e2cc8d165adc4c792eeb195717de2bcc7b39be1ce77959d78e87ef685";
const UPSTREAM_NOTICES_SHA256 =
  "58f8d237355fafb7832f9ad4e418aacd248223fd7818c36c00111da48caa279a";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function verifyRequiredRecord(
  text: string,
  requiredValues: readonly string[],
  label: string,
): void {
  const normalized = text.replace(/\s+/g, " ");
  for (const required of requiredValues)
    assert(
      normalized.includes(required),
      `${label} is missing required record: ${required}`,
    );
}

function verifyPinnedSnapshot(repositoryRoot: string): void {
  const result = spawnSync(
    process.execPath,
    [path.join(repositoryRoot, "scripts/import-pi-live.ts"), "check"],
    { cwd: repositoryRoot, encoding: "utf8", timeout: 30_000 },
  );
  if (result.error) throw result.error;
  assert(
    result.status === 0,
    `Pinned upstream check failed: ${(result.stderr || result.stdout).trim()}`,
  );
}

async function verifyPackage(repositoryRoot: string): Promise<number> {
  const payload = inspectPiLivePackagePayload(repositoryRoot);
  const license = await readFile(path.join(payload.root, "LICENSE"));
  assert(
    piLiveSha256(license) === LICENSE_SHA256,
    "Package LICENSE is not the exact extension license",
  );
  const upstreamNotices = await readFile(
    path.join(payload.root, "UPSTREAM_THIRD_PARTY_NOTICES.md"),
  );
  assert(
    piLiveSha256(upstreamNotices) === UPSTREAM_NOTICES_SHA256,
    "Package upstream notices are not exact",
  );

  verifyRequiredRecord(
    await readFile(path.join(payload.root, "PROVENANCE.md"), "utf8"),
    [
      "db2c57f13c274d66d79287fda8de177c016f0c02",
      "39171682343754366439b2c0890f5b0f4c3ed891",
      "3aea19fabc79a2ec8f00469edc97b668b246ec94",
      "f7f8e040ee04710414fbd775431091fa301b9786",
      PI_LIVE_NATIVE_BINARY_SHA256,
      PI_LIVE_NATIVE_MANIFEST_SHA256,
      PI_LIVE_NATIVE_README_SHA256,
      PI_LIVE_NOTICE_MANIFEST_SHA256,
      PI_LIVE_FULL_LOCK_SHA256,
      PI_LIVE_PRODUCTION_LOCK_SHA256,
      "does not claim legal clearance",
      "not committed, mirrored, or republished",
      "complete target-specific SBOM",
    ],
    "Package provenance",
  );
  verifyRequiredRecord(
    await readFile(path.join(payload.root, "THIRD_PARTY_NOTICES.md"), "utf8"),
    [
      "Matt Leong",
      "monotykamary",
      "Mario Zechner",
      "Can Bölük",
      "Silver.ttf",
      "Creative Commons Attribution 4.0",
      "Roger Zurawicki",
      "OpenAI, Shantanu Jain",
      "Opus",
      "miniaudio",
      "PCRE2",
      "SLJIT",
      "objc2",
      `${PI_LIVE_NOTICE_FILE_COUNT} exact full texts and source headers`,
      "not a complete target-specific SBOM or independent legal clearance",
      "accepted residual risk",
    ],
    "Package third-party notices",
  );

  assert(
    payload.noticeCorpus.files.length === PI_LIVE_NOTICE_FILE_COUNT,
    "Package notice corpus count differs",
  );
  for (const noticeFile of payload.noticeCorpus.files)
    assert(
      payload.hashes[noticeFile.packageRelative] === noticeFile.sha256,
      `Package notice corpus is absent from the payload fingerprint: ${noticeFile.relative}`,
    );

  return payload.files.length;
}

async function main(): Promise<void> {
  assert(process.argv.length === 2, "Usage: node scripts/check-pi-live.ts");
  const repositoryRoot = path.resolve(import.meta.dirname, "..");
  verifyPinnedSnapshot(repositoryRoot);
  const fileCount = await verifyPackage(repositoryRoot);
  console.log(
    `Verified standalone pi-live package: 24-file pinned upstream snapshot, ${fileCount}-file runtime payload, ${PI_LIVE_NOTICE_FILE_COUNT} exact notice texts/source headers, exact manifest policy, and frozen lock.`,
  );
}

main().catch((error: unknown) => {
  console.error(`pi-live package check failed: ${errorMessage(error)}`);
  process.exitCode = 1;
});
