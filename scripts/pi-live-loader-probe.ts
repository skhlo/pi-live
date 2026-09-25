import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import path from "node:path";

import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

async function assertEmpty(directory: string): Promise<void> {
  assert.deepEqual(
    await readdir(directory),
    [],
    `Pi Live loader isolation directory is not empty: ${directory}`,
  );
}

async function assertMissing(file: string, label: string): Promise<void> {
  try {
    await lstat(file);
    assert.fail(`${label} must be absent`);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    )
      return;
    throw error;
  }
}

async function packageNodeModulesState(
  packageRoot: string,
  expected: string,
): Promise<"absent" | "present"> {
  assert.ok(
    expected === "absent" || expected === "present",
    "Expected package node_modules state",
  );
  const nodeModules = path.join(packageRoot, "node_modules");
  try {
    const info = await lstat(nodeModules);
    assert.equal(expected, "present", "Package node_modules must be absent");
    assert.ok(
      info.isDirectory() && !info.isSymbolicLink(),
      "Package node_modules must be a real directory",
    );
    for (const peer of [
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-tui",
    ])
      await assertMissing(
        path.join(nodeModules, ...peer.split("/")),
        `Package-local ${peer}`,
      );
    return "present";
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      assert.equal(expected, "absent", "Package node_modules must be present");
      return "absent";
    }
    throw error;
  }
}

async function readManifest(file: string): Promise<Record<string, unknown>> {
  const info = await lstat(file);
  assert.ok(
    info.isFile() && !info.isSymbolicLink(),
    `Loader manifest is missing or redirected: ${file}`,
  );
  const value: unknown = JSON.parse(await readFile(file, "utf8"));
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `Loader manifest is malformed: ${file}`,
  );
  return value as Record<string, unknown>;
}

function deniedChildProcessCode(): string {
  for (const [command, args] of [
    ["/usr/bin/true", []],
    [process.execPath, ["--input-type=module", "-e", ""]],
  ] as const) {
    const result = spawnSync(command, args, { stdio: "ignore" });
    const error = result.error as NodeJS.ErrnoException | undefined;
    assert.equal(
      error?.code,
      "EPERM",
      `OS process sandbox unexpectedly allowed child execution: ${command}`,
    );
  }
  return "EPERM";
}

async function deniedFileWriteCode(
  directories: readonly string[],
): Promise<string> {
  for (const directory of directories) {
    const target = path.join(directory, ".pi-live-write-probe");
    try {
      await writeFile(target, "forbidden\n", { flag: "wx" });
      await unlink(target).catch(() => undefined);
      throw new Error(`OS filesystem sandbox allowed a write: ${directory}`);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        (error as NodeJS.ErrnoException).code !== "EPERM"
      )
        throw error;
    }
  }
  return "EPERM";
}

async function deniedNetworkCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port: 9 });
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error("OS network sandbox unexpectedly allowed a connection"));
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code !== "EPERM") {
        reject(
          new Error(
            `OS network sandbox returned ${error.code ?? "unknown"}, not EPERM`,
          ),
        );
        return;
      }
      resolve(error.code);
    });
  });
}

async function main(): Promise<void> {
  assert.equal(
    process.argv.length,
    8,
    "Usage: pi-live-loader-probe <package> <agent-dir> <session-dir> <pi-manifest> <tui-manifest> <absent|present>",
  );
  const [
    packageRoot,
    agentDirectory,
    sessionDirectory,
    piManifestPath,
    tuiManifestPath,
    expectedNodeModules,
  ] = process.argv.slice(2);
  assert.ok(packageRoot);
  assert.ok(agentDirectory);
  assert.ok(sessionDirectory);
  assert.ok(piManifestPath);
  assert.ok(tuiManifestPath);
  assert.ok(expectedNodeModules);
  assert.equal(process.env.PI_CODING_AGENT_DIR, agentDirectory);
  assert.equal(process.env.PI_CODING_AGENT_SESSION_DIR, sessionDirectory);
  assert.equal(process.env.PI_OFFLINE, "1");
  assert.equal(process.env.PI_SKIP_VERSION_CHECK, "1");
  assert.equal(process.env.PI_TELEMETRY, "0");
  assert.equal(process.env.USERPROFILE, process.env.HOME);
  assert.equal(process.execArgv.includes("--no-addons"), true);

  const homeDirectory = process.env.HOME;
  const scratch = process.env.TMPDIR;
  const xdgDirectories = [
    process.env.XDG_CONFIG_HOME,
    process.env.XDG_CACHE_HOME,
    process.env.XDG_DATA_HOME,
    process.env.XDG_STATE_HOME,
  ];
  assert.ok(homeDirectory && path.isAbsolute(homeDirectory));
  assert.ok(scratch && path.isAbsolute(scratch));
  assert.ok(
    xdgDirectories.every(
      (directory): directory is string =>
        typeof directory === "string" && path.isAbsolute(directory),
    ),
    "Loader XDG directories must be absolute",
  );
  const isolatedDirectories = [
    homeDirectory,
    agentDirectory,
    sessionDirectory,
    scratch,
    process.cwd(),
    ...xdgDirectories,
  ];
  for (const directory of isolatedDirectories) await assertEmpty(directory);

  const nodeModules = await packageNodeModulesState(
    packageRoot,
    expectedNodeModules,
  );
  const scratchProbe = path.join(scratch, "scratch-write-probe");
  await writeFile(scratchProbe, "allowed\n", { flag: "wx" });
  await unlink(scratchProbe);
  const childProcessError = deniedChildProcessCode();
  const fileWriteError = await deniedFileWriteCode([
    homeDirectory,
    agentDirectory,
    sessionDirectory,
    process.cwd(),
    packageRoot,
  ]);
  const packageManifest = await readManifest(
    path.join(packageRoot, "package.json"),
  );
  assert.deepEqual(packageManifest.peerDependencies, {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
  });
  assert.deepEqual(packageManifest.pi, { extensions: ["./index.ts"] });
  const piManifest = await readManifest(piManifestPath);
  const tuiManifest = await readManifest(tuiManifestPath);
  assert.deepEqual(
    [piManifest.name, piManifest.version],
    ["@earendil-works/pi-coding-agent", "0.87.1"],
  );
  assert.deepEqual(
    [tuiManifest.name, tuiManifest.version],
    ["@earendil-works/pi-tui", "0.87.1"],
  );

  const networkError = await deniedNetworkCode();
  const loaded = await discoverAndLoadExtensions(
    [path.join(packageRoot, "index.ts")],
    process.cwd(),
    agentDirectory,
  );
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const extension = loaded.extensions[0]!;
  assert.deepEqual([...extension.commands.keys()], ["live"]);
  assert.deepEqual([...extension.shortcuts.keys()], ["ctrl+shift+l"]);
  assert.deepEqual(
    [...extension.messageRenderers.keys()],
    ["better-openai-live-delegation"],
  );
  assert.deepEqual([...extension.handlers.keys()].sort(), [
    "agent_settled",
    "agent_start",
    "message_end",
    "session_before_fork",
    "session_before_switch",
    "session_before_tree",
    "session_shutdown",
    "session_start",
    "ui_prompt_end",
    "ui_prompt_start",
  ]);
  assert.deepEqual([...extension.tools.keys()], []);
  assert.deepEqual([...extension.flags.keys()], []);
  for (const directory of [
    homeDirectory,
    agentDirectory,
    sessionDirectory,
    process.cwd(),
    ...xdgDirectories,
  ])
    await assertEmpty(directory);

  console.log(
    JSON.stringify({
      pi: piManifest.version,
      tui: tuiManifest.version,
      piAliases: "loader-supplied",
      networkError,
      childProcessError,
      fileWriteError,
      nativeAddons: "disabled",
      packageNodeModules: nodeModules,
      extensions: loaded.extensions.length,
    }),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
