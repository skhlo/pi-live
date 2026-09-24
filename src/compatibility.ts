import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import { getPackageDir } from "@earendil-works/pi-coding-agent";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const PI_VERSION = "0.87.1";
const NATIVE_PACKAGE = "@oh-my-pi/pi-natives-darwin-arm64";
const NATIVE_VERSION = "17.2.9";

export type PackageMetadata = {
  name?: unknown;
  version?: unknown;
  os?: unknown;
  cpu?: unknown;
};

export interface CompatibilityEnvironment {
  nodeVersion(): string;
  platform(): NodeJS.Platform;
  architecture(): string;
  readPiMetadata(): Promise<PackageMetadata>;
  readNativeMetadata(): Promise<PackageMetadata>;
}

export type CompatibilityIssue =
  | "node-version"
  | "pi-version"
  | "platform"
  | "architecture"
  | "native-metadata";

export type CompatibilityResult = {
  supported: boolean;
  issues: CompatibilityIssue[];
};

export interface CompatibilityChecker {
  check(): Promise<CompatibilityResult>;
}

function supportsNode(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 22 || (major === 22 && minor >= 19);
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

async function readPackageMetadata(file: string): Promise<PackageMetadata> {
  const info = await lstat(file);
  if (info.isSymbolicLink() || !info.isFile())
    throw new Error("package metadata is not a regular file");
  const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("package metadata is malformed");
  return parsed as PackageMetadata;
}

function createRealEnvironment(): CompatibilityEnvironment {
  return {
    nodeVersion: () => process.versions.node,
    platform: () => process.platform,
    architecture: () => process.arch,
    readPiMetadata: () =>
      readPackageMetadata(path.join(getPackageDir(), "package.json")),
    readNativeMetadata: () =>
      readPackageMetadata(
        path.resolve(
          import.meta.dirname,
          `../node_modules/${NATIVE_PACKAGE}/package.json`,
        ),
      ),
  };
}

export function createCompatibilityChecker(
  environment: CompatibilityEnvironment = createRealEnvironment(),
): CompatibilityChecker {
  return {
    async check(): Promise<CompatibilityResult> {
      const issues: CompatibilityIssue[] = [];
      if (!supportsNode(environment.nodeVersion())) issues.push("node-version");
      if (environment.platform() !== "darwin") issues.push("platform");
      if (environment.architecture() !== "arm64") issues.push("architecture");

      try {
        const metadata = await environment.readPiMetadata();
        if (metadata.name !== PI_PACKAGE || metadata.version !== PI_VERSION)
          issues.push("pi-version");
      } catch {
        issues.push("pi-version");
      }

      try {
        const metadata = await environment.readNativeMetadata();
        if (
          metadata.name !== NATIVE_PACKAGE ||
          metadata.version !== NATIVE_VERSION ||
          !stringArray(metadata.os)?.includes("darwin") ||
          !stringArray(metadata.cpu)?.includes("arm64")
        )
          issues.push("native-metadata");
      } catch {
        issues.push("native-metadata");
      }

      return { supported: issues.length === 0, issues };
    },
  };
}
