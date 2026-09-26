import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import {
  createIsolatedLiveCoordination,
  createLiveHomeAuthority,
  createLiveLifecycle,
  liveMountIsLocal,
  setupLiveHome,
  type LiveSetupOptions,
} from "../src/live.ts";
import {
  admitted,
  approvingConsent,
  createFakeResources,
} from "./test-support/live-fixture.ts";

async function emptyHome(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "pi-live-setup-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  await mkdir(home);
  const stateParent = path.join(await realpath(home), ".local/state/pi-live");
  const local: LiveSetupOptions = {
    accountHome: () => home,
    environmentHome: () => home,
    localFilesystem: async () => true,
  };
  const lifecycle = () =>
    createLiveLifecycle({
      admission: { check: admitted },
      consent: approvingConsent,
      resources: createFakeResources(),
      home: createLiveHomeAuthority({
        accountHome: () => home,
        environmentHome: () => home,
      }),
      coordination: createIsolatedLiveCoordination(),
    });
  return { root, home, stateParent, local, lifecycle };
}

async function startsAndStops(
  lifecycle: ReturnType<typeof createLiveLifecycle>,
): Promise<void> {
  assert.equal((await lifecycle.start()).kind, "started");
  assert.deepEqual(await lifecycle.stop(), { status: "off" });
}

test("calls refuse with setup-required until /live setup records the home", async (t) => {
  const fixture = await emptyHome(t);
  assert.deepEqual(await fixture.lifecycle().start(), {
    kind: "refused",
    state: "off",
    diagnostic: "setup-required",
  });

  assert.deepEqual(await setupLiveHome(fixture.local), {
    kind: "ready",
    stateParent: fixture.stateParent,
  });
  assert.equal((await stat(fixture.stateParent)).mode & 0o777, 0o700);
  const record = path.join(fixture.stateParent, "setup.json");
  assert.equal((await stat(record)).mode & 0o777, 0o600);
  assert.equal(
    JSON.parse(await readFile(record, "utf8")).stateParent,
    fixture.stateParent,
  );

  const lifecycle = fixture.lifecycle();
  await startsAndStops(lifecycle);
  await startsAndStops(lifecycle);
});

test("setup is repeatable and makes an existing state directory private", async (t) => {
  const fixture = await emptyHome(t);
  await mkdir(fixture.stateParent, { recursive: true, mode: 0o755 });
  await chmod(fixture.stateParent, 0o755);
  assert.equal((await setupLiveHome(fixture.local)).kind, "ready");
  assert.equal((await stat(fixture.stateParent)).mode & 0o777, 0o700);
  assert.equal((await setupLiveHome(fixture.local)).kind, "ready");
  await startsAndStops(fixture.lifecycle());
});

test("a replaced state directory or a loosened record needs setup again", async (t) => {
  const fixture = await emptyHome(t);
  assert.equal((await setupLiveHome(fixture.local)).kind, "ready");
  const record = path.join(fixture.stateParent, "setup.json");

  await chmod(record, 0o644);
  assert.deepEqual(await fixture.lifecycle().start(), {
    kind: "refused",
    state: "off",
    diagnostic: "setup-required",
  });
  await chmod(record, 0o600);
  await startsAndStops(fixture.lifecycle());

  const moved = `${fixture.stateParent}-old`;
  await rename(fixture.stateParent, moved);
  await mkdir(fixture.stateParent, { mode: 0o700 });
  await writeFile(
    path.join(fixture.stateParent, "setup.json"),
    await readFile(path.join(moved, "setup.json")),
    { mode: 0o600 },
  );
  assert.deepEqual(await fixture.lifecycle().start(), {
    kind: "refused",
    state: "off",
    diagnostic: "setup-required",
  });
  assert.equal((await setupLiveHome(fixture.local)).kind, "ready");
  await startsAndStops(fixture.lifecycle());
});

test("setup refuses non-local disks, redirected folders and a divergent HOME", async (t) => {
  const fixture = await emptyHome(t);
  assert.deepEqual(
    await setupLiveHome({
      ...fixture.local,
      localFilesystem: async () => false,
    }),
    {
      kind: "refused",
      reason: `${fixture.stateParent} is not on a local disk.`,
    },
  );
  await assert.rejects(stat(path.join(fixture.stateParent, "setup.json")), {
    code: "ENOENT",
  });

  assert.equal(
    (
      await setupLiveHome({
        ...fixture.local,
        environmentHome: () => fixture.root,
      })
    ).kind,
    "refused",
  );

  const redirected = await emptyHome(t);
  const elsewhere = path.join(redirected.root, "elsewhere");
  await mkdir(elsewhere);
  await symlink(elsewhere, path.join(redirected.home, ".local"));
  const result = await setupLiveHome(redirected.local);
  assert.equal(result.kind, "refused");
  assert.match(
    result.kind === "refused" ? result.reason : "",
    /not a real directory you own/,
  );
  assert.equal((await lstat(path.join(elsewhere))).isDirectory(), true);
  await assert.rejects(stat(path.join(elsewhere, "state")), {
    code: "ENOENT",
  });
});

test("mount parsing requires the local flag on the target's own mount", () => {
  const mount = [
    "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)",
    "/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse)",
    "//user@server/share on /Volumes/team share (smbfs, nodev, nosuid, mounted by user)",
    "map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)",
  ].join("\n");
  const df = (filesystem: string, mountPoint: string) =>
    `Filesystem 512-blocks Used Available Capacity Mounted on\n${filesystem} 100 50 50 50% ${mountPoint}\n`;
  assert.equal(
    liveMountIsLocal(df("/dev/disk3s5", "/System/Volumes/Data"), mount),
    true,
  );
  assert.equal(
    liveMountIsLocal(df("//user@server/share", "/Volumes/team share"), mount),
    false,
  );
  assert.equal(
    liveMountIsLocal(df("map auto_home", "/System/Volumes/Data/home"), mount),
    false,
  );
  assert.equal(liveMountIsLocal(df("/dev/disk9", "/missing"), mount), false);
  assert.equal(liveMountIsLocal("", mount), false);
});

test(
  "the default local-disk check accepts a temporary folder on macOS",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const fixture = await emptyHome(t);
    assert.equal(
      (
        await setupLiveHome({
          accountHome: fixture.local.accountHome,
          environmentHome: fixture.local.environmentHome,
        })
      ).kind,
      "ready",
    );
  },
);
