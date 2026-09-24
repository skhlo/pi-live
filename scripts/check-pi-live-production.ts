import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { checkPiLiveLoader } from "./check-pi-live-loader.ts";
import {
  copyPiLivePayloadFixture,
  inspectPiLivePackagePayload,
  PI_LIVE_MINIMUM_NODE,
  PI_LIVE_PNPM_VERSION,
  PI_LIVE_PRODUCTION_INSTALL_ARGS,
  PI_LIVE_PRODUCTION_PACKAGES,
  PI_LIVE_PUBLIC_REGISTRY,
  verifyPiLivePayloadCopy,
  verifyPiLiveProductionInstall,
  versionAtLeast,
  versionTuple,
} from "./pi-live-package.ts";

export type PiLiveProductionReceipt = {
  pnpm: "11.8.0";
  packages: 9;
  scripts: "disabled";
  automaticPeers: "disabled";
  piPeers: "loader-supplied";
  loader: "sandboxed-no-addons";
};

export type PiLiveProductionCheckOptions = {
  repositoryRoot?: string;
  pnpmCommand?: string;
  temporaryParent?: string;
};

type ProductionEnvironment = {
  root: string;
  env: NodeJS.ProcessEnv;
};

function assertEmpty(directory: string): void {
  assert.deepEqual(
    readdirSync(directory),
    [],
    `Expected an empty production fixture directory: ${directory}`,
  );
}

function createProductionEnvironment(parent: string): ProductionEnvironment {
  const root = path.join(parent, "environment");
  mkdirSync(root, { mode: 0o700 });
  const directories = Object.fromEntries(
    [
      "home",
      "xdg-config",
      "xdg-cache",
      "xdg-data",
      "xdg-state",
      "tmp",
      "store",
      "npm-cache",
      "corepack",
    ].map((name) => {
      const directory = path.join(root, name);
      mkdirSync(directory, { mode: 0o700 });
      return [name, directory];
    }),
  ) as Record<string, string>;
  for (const directory of Object.values(directories)) assertEmpty(directory);

  const userNpmrc = path.join(root, "user.npmrc");
  const globalNpmrc = path.join(root, "global.npmrc");
  writeFileSync(userNpmrc, "", { flag: "wx", mode: 0o600 });
  writeFileSync(globalNpmrc, "", { flag: "wx", mode: 0o600 });
  chmodSync(userNpmrc, 0o600);
  chmodSync(globalNpmrc, 0o600);

  return {
    root,
    env: {
      COREPACK_HOME: directories.corepack,
      HOME: directories.home,
      LANG: "en_US.UTF-8",
      PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
      TEMP: directories.tmp,
      TMP: directories.tmp,
      TMPDIR: `${directories.tmp}${path.sep}`,
      USERPROFILE: directories.home,
      XDG_CACHE_HOME: directories["xdg-cache"],
      XDG_CONFIG_HOME: directories["xdg-config"],
      XDG_DATA_HOME: directories["xdg-data"],
      XDG_STATE_HOME: directories["xdg-state"],
      npm_config_cache: directories["npm-cache"],
      npm_config_globalconfig: globalNpmrc,
      npm_config_registry: PI_LIVE_PUBLIC_REGISTRY,
      npm_config_store_dir: directories.store,
      npm_config_userconfig: userNpmrc,
    },
  };
}

function checkedSpawn(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeout: number,
): string {
  const result = spawnSync(command, [...args], {
    cwd,
    encoding: "utf8",
    env,
    timeout,
  });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`,
  );
  return result.stdout;
}

function verifyProductionHost(): void {
  assert.equal(process.platform, "darwin", "Production check requires macOS");
  assert.equal(process.arch, "arm64", "Production check requires arm64");
  assert.ok(
    versionAtLeast(versionTuple(process.versions.node), PI_LIVE_MINIMUM_NODE),
    "Production check requires Node >=22.19.0",
  );
}

export function checkPiLiveProduction(
  options: PiLiveProductionCheckOptions = {},
): PiLiveProductionReceipt {
  verifyProductionHost();
  const repositoryRoot = path.resolve(
    options.repositoryRoot ?? path.resolve(import.meta.dirname, ".."),
  );
  const source = inspectPiLivePackagePayload(repositoryRoot);
  const temporaryParent = options.temporaryParent ?? tmpdir();
  const temporaryRoot = mkdtempSync(
    path.join(temporaryParent, "pi-live-production-check-"),
  );
  const packageRoot = path.join(temporaryRoot, "package");
  const pnpmCommand = options.pnpmCommand ?? "pnpm";

  try {
    copyPiLivePayloadFixture(source, packageRoot);
    assert.equal(
      lstatSync(path.join(packageRoot, "node_modules"), {
        throwIfNoEntry: false,
      }),
      undefined,
      "Production fixture must start without node_modules",
    );
    const isolated = createProductionEnvironment(temporaryRoot);
    const pnpmVersion = checkedSpawn(
      pnpmCommand,
      ["--version"],
      packageRoot,
      isolated.env,
      30_000,
    ).trim();
    assert.equal(
      pnpmVersion,
      PI_LIVE_PNPM_VERSION,
      `Production check requires pnpm ${PI_LIVE_PNPM_VERSION}`,
    );

    checkedSpawn(
      pnpmCommand,
      PI_LIVE_PRODUCTION_INSTALL_ARGS,
      packageRoot,
      isolated.env,
      180_000,
    );

    const verifyInstalledPackage = (): void => {
      verifyPiLivePayloadCopy(packageRoot, source);
      verifyPiLiveProductionInstall(packageRoot);
    };
    checkPiLiveLoader(packageRoot, "present", verifyInstalledPackage);

    return {
      pnpm: PI_LIVE_PNPM_VERSION,
      packages: PI_LIVE_PRODUCTION_PACKAGES.length,
      scripts: "disabled",
      automaticPeers: "disabled",
      piPeers: "loader-supplied",
      loader: "sandboxed-no-addons",
    };
  } finally {
    rmSync(temporaryRoot, { recursive: true });
  }
}

function main(): void {
  assert.equal(
    process.argv.length,
    2,
    "Usage: node scripts/check-pi-live-production.ts",
  );
  const receipt = checkPiLiveProduction();
  console.log(
    `Verified disposable Pi Live production fixture: pnpm ${receipt.pnpm}, ${receipt.packages} exact runtime packages, scripts and automatic peers disabled, exact native hashes, and unchanged closure before/after the sandboxed --no-addons loader.`,
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
      `pi-live production check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
