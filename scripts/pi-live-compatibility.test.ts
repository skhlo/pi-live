import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createCompatibilityChecker,
  type CompatibilityEnvironment,
  type PackageMetadata,
} from "../src/compatibility.ts";

const piMetadata: PackageMetadata = {
  name: "@earendil-works/pi-coding-agent",
  version: "0.87.1",
};
const nativeMetadata: PackageMetadata = {
  name: "@oh-my-pi/pi-natives-darwin-arm64",
  version: "17.2.9",
  os: ["darwin"],
  cpu: ["arm64"],
};

function compatibleEnvironment(
  overrides: Partial<CompatibilityEnvironment> = {},
): CompatibilityEnvironment {
  return {
    nodeVersion: () => "22.19.0",
    platform: () => "darwin",
    architecture: () => "arm64",
    readPiMetadata: async () => piMetadata,
    readNativeMetadata: async () => nativeMetadata,
    ...overrides,
  };
}

test("compatibility is lazy and accepts exactly Pi 0.87.1, Node >=22.19, darwin arm64, and native metadata 17.2.9", async () => {
  let piReads = 0;
  let nativeReads = 0;
  const checker = createCompatibilityChecker(
    compatibleEnvironment({
      nodeVersion: () => "23.0.0",
      readPiMetadata: async () => {
        piReads += 1;
        return piMetadata;
      },
      readNativeMetadata: async () => {
        nativeReads += 1;
        return nativeMetadata;
      },
    }),
  );

  assert.equal(piReads, 0);
  assert.equal(nativeReads, 0);
  assert.deepEqual(await checker.check(), { supported: true, issues: [] });
  assert.equal(piReads, 1);
  assert.equal(nativeReads, 1);
});

test("compatibility reports every fixed mismatch without loading the native addon", async () => {
  const checker = createCompatibilityChecker(
    compatibleEnvironment({
      nodeVersion: () => "22.18.9",
      platform: () => "linux",
      architecture: () => "x64",
      readPiMetadata: async () => ({ ...piMetadata, version: "0.87.2" }),
      readNativeMetadata: async () => ({
        ...nativeMetadata,
        version: "17.3.0",
      }),
    }),
  );

  assert.deepEqual(await checker.check(), {
    supported: false,
    issues: [
      "node-version",
      "platform",
      "architecture",
      "pi-version",
      "native-metadata",
    ],
  });
});
