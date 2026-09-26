import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const LIVE_VOICE_VALUES = [
  "alloy",
  "ash",
  "ballad",
  "beacon",
  "bossa",
  "cedar",
  "cinder",
  "coral",
  "delta",
  "echo",
  "gleam",
  "marin",
  "meridian",
  "quartz",
  "ripple",
  "sage",
  "shimmer",
  "stone",
  "tempo",
  "verse",
  "vesper",
  "willow",
] as const;

export type LiveVoice = (typeof LIVE_VOICE_VALUES)[number];
export const DEFAULT_LIVE_VOICE: LiveVoice = "marin";

export type LivePreferences = {
  voice: LiveVoice;
  fields: Record<string, unknown>;
};

export type PreferenceErrorCode = "malformed" | "invalid-voice" | "unsafe-path";

export class PreferenceError extends Error {
  readonly code: PreferenceErrorCode;

  constructor(code: PreferenceErrorCode, detail?: string) {
    super(`Pi Live preference error: ${code}${detail ? `: ${detail}` : ""}`);
    this.name = "PreferenceError";
    this.code = code;
  }
}

export interface PreferenceStore {
  load(): Promise<LivePreferences>;
  setVoice(voice: LiveVoice): Promise<void>;
}

export function isLiveVoice(value: unknown): value is LiveVoice {
  return (
    typeof value === "string" &&
    (LIVE_VOICE_VALUES as readonly string[]).includes(value)
  );
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function isMissing(error: unknown): boolean {
  return isErrorCode(error, "ENOENT");
}

type Identity = {
  dev: bigint;
  ino: bigint;
  mode: number;
};

type PreferenceSnapshot = LivePreferences & {
  identity?: Identity;
  sha256?: string;
};

function identity(info: { dev: bigint; ino: bigint; mode: bigint }): Identity {
  return { dev: info.dev, ino: info.ino, mode: Number(info.mode & 0o777n) };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertIdentity(actual: Identity, expected: Identity): void {
  if (
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino ||
    actual.mode !== expected.mode
  )
    throw new PreferenceError("unsafe-path");
}

async function readPrivateDirectory(
  directory: string,
): Promise<Identity | undefined> {
  let info;
  try {
    info = await lstat(directory, { bigint: true });
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw new PreferenceError("unsafe-path");
  }
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    Number(info.mode & 0o777n) !== 0o700
  )
    throw new PreferenceError("unsafe-path");
  return identity(info);
}

async function ensurePrivateDirectory(directory: string): Promise<Identity> {
  const existing = await readPrivateDirectory(directory);
  if (existing) return existing;
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (!isErrorCode(error, "EEXIST")) throw error;
  }
  const created = await readPrivateDirectory(directory);
  if (!created) throw new PreferenceError("unsafe-path");
  return created;
}

async function openPrivateFile(
  file: string,
): Promise<{ handle: FileHandle; identity: Identity } | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw new PreferenceError("unsafe-path");
  }
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile() || Number(info.mode & 0o777n) !== 0o600)
      throw new PreferenceError("unsafe-path");
    return { handle, identity: identity(info) };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function readPreferenceSnapshot(
  configPath: string,
): Promise<PreferenceSnapshot> {
  const opened = await openPrivateFile(configPath);
  if (!opened) return { voice: DEFAULT_LIVE_VOICE, fields: {} };
  try {
    const bytes = await opened.handle.readFile();
    assertIdentity(
      identity(await opened.handle.stat({ bigint: true })),
      opened.identity,
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new PreferenceError("malformed");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new PreferenceError("malformed");
    const fields = parsed as Record<string, unknown>;
    const voice = Object.hasOwn(fields, "voice")
      ? fields.voice
      : DEFAULT_LIVE_VOICE;
    if (!isLiveVoice(voice)) throw new PreferenceError("invalid-voice");
    return {
      voice,
      fields,
      identity: opened.identity,
      sha256: sha256(bytes),
    };
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

async function loadPreferences(
  directory: string,
  configPath: string,
): Promise<LivePreferences> {
  const directoryIdentity = await readPrivateDirectory(directory);
  if (!directoryIdentity) return { voice: DEFAULT_LIVE_VOICE, fields: {} };
  const { voice, fields } = await readPreferenceSnapshot(configPath);
  return { voice, fields };
}

async function assertDirectoryUnchanged(
  directory: string,
  expected: Identity,
): Promise<void> {
  const current = await readPrivateDirectory(directory);
  if (!current) throw new PreferenceError("unsafe-path");
  assertIdentity(current, expected);
}

function samePreferenceSnapshot(
  current: PreferenceSnapshot,
  expected: PreferenceSnapshot,
): boolean {
  if (!expected.identity || !current.identity)
    return !expected.identity && !current.identity;
  return (
    current.sha256 === expected.sha256 &&
    current.identity.dev === expected.identity.dev &&
    current.identity.ino === expected.identity.ino &&
    current.identity.mode === expected.identity.mode
  );
}

function isValidConcurrentChange(
  current: PreferenceSnapshot,
  expected: PreferenceSnapshot,
): boolean {
  return Boolean(current.identity) || !expected.identity;
}

async function openUniqueTemporary(
  temporaryPath: string,
): Promise<{ handle: FileHandle; identity: Identity }> {
  const handle = await open(
    temporaryPath,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  let createdIdentity: Identity | undefined;
  try {
    const created = await handle.stat({ bigint: true });
    if (!created.isFile()) throw new PreferenceError("unsafe-path");
    createdIdentity = identity(created);
    await handle.chmod(0o600);
    const info = await handle.stat({ bigint: true });
    if (!info.isFile() || Number(info.mode & 0o777n) !== 0o600)
      throw new PreferenceError("unsafe-path");
    return { handle, identity: identity(info) };
  } catch (error) {
    let cleanupFailed = false;
    try {
      await handle.close();
    } catch {
      cleanupFailed = true;
    }
    try {
      const current = await lstat(temporaryPath, { bigint: true });
      if (
        current.isSymbolicLink() ||
        !current.isFile() ||
        (createdIdentity &&
          (current.dev !== createdIdentity.dev ||
            current.ino !== createdIdentity.ino))
      )
        throw new PreferenceError("unsafe-path");
      await unlink(temporaryPath);
    } catch {
      cleanupFailed = true;
    }
    if (cleanupFailed)
      throw new PreferenceError("unsafe-path", "temporary cleanup failed");
    throw error;
  }
}

async function assertOwnedTemporary(
  temporaryPath: string,
  expected: Identity,
): Promise<void> {
  let info;
  try {
    info = await lstat(temporaryPath, { bigint: true });
  } catch (error) {
    if (isMissing(error))
      throw new PreferenceError("unsafe-path", "temporary file disappeared");
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile())
    throw new PreferenceError("unsafe-path", "temporary file was replaced");
  assertIdentity(identity(info), expected);
}

async function removeOwnedTemporary(
  temporaryPath: string,
  expected: Identity,
): Promise<void> {
  try {
    await assertOwnedTemporary(temporaryPath, expected);
    await unlink(temporaryPath);
  } catch (error) {
    if (isMissing(error)) return;
    if (error instanceof PreferenceError) throw error;
    throw new PreferenceError("unsafe-path", "temporary cleanup failed");
  }
}

async function syncPrivateDirectory(
  directory: string,
  expected: Identity,
): Promise<void> {
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isDirectory()) throw new PreferenceError("unsafe-path");
    assertIdentity(identity(info), expected);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function createFilePreferenceStore(
  getAgentDirectory: () => string = getAgentDir,
): PreferenceStore {
  const paths = () => {
    const directory = path.join(getAgentDirectory(), "pi-live");
    return {
      directory,
      configPath: path.join(directory, "config.json"),
    };
  };

  const store: PreferenceStore = {
    async load(): Promise<LivePreferences> {
      const { directory, configPath } = paths();
      return loadPreferences(directory, configPath);
    },

    async setVoice(voice: LiveVoice): Promise<void> {
      if (!isLiveVoice(voice)) throw new PreferenceError("invalid-voice");
      const { directory, configPath } = paths();
      const directoryIdentity = await ensurePrivateDirectory(directory);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        let temporaryPath: string | undefined;
        let temporaryIdentity: Identity | undefined;
        let temporaryHandle: FileHandle | undefined;
        let operationError: unknown;
        let retry = false;
        try {
          await assertDirectoryUnchanged(directory, directoryIdentity);
          const expected = await readPreferenceSnapshot(configPath);
          await assertDirectoryUnchanged(directory, directoryIdentity);
          temporaryPath = path.join(
            directory,
            `.config.json.${randomUUID()}.tmp`,
          );
          const bytes = Buffer.from(
            `${JSON.stringify({ ...expected.fields, voice }, null, 2)}\n`,
          );
          const temporary = await openUniqueTemporary(temporaryPath);
          temporaryHandle = temporary.handle;
          temporaryIdentity = temporary.identity;
          await temporaryHandle.writeFile(bytes);
          await temporaryHandle.sync();
          await temporaryHandle.close();
          temporaryHandle = undefined;

          await assertDirectoryUnchanged(directory, directoryIdentity);
          const current = await readPreferenceSnapshot(configPath);
          await assertDirectoryUnchanged(directory, directoryIdentity);
          if (!samePreferenceSnapshot(current, expected)) {
            if (!isValidConcurrentChange(current, expected))
              throw new PreferenceError("unsafe-path");
            retry = true;
          } else {
            await assertOwnedTemporary(temporaryPath, temporaryIdentity);
            await rename(temporaryPath, configPath);
            temporaryPath = undefined;
            temporaryIdentity = undefined;
            await syncPrivateDirectory(directory, directoryIdentity);
          }
        } catch (error) {
          operationError =
            error instanceof PreferenceError
              ? error
              : new PreferenceError("unsafe-path");
        }

        let cleanupError: unknown;
        try {
          await temporaryHandle?.close();
          if (temporaryPath && temporaryIdentity)
            await removeOwnedTemporary(temporaryPath, temporaryIdentity);
        } catch (error) {
          cleanupError =
            error instanceof PreferenceError
              ? error
              : new PreferenceError("unsafe-path", "temporary cleanup failed");
        }
        if (cleanupError) throw cleanupError;
        if (operationError) throw operationError;
        if (!retry) return;
      }
      throw new PreferenceError("unsafe-path", "too many concurrent updates");
    },
  };
  return store;
}
