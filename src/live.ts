import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rmdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { userInfo } from "node:os";
import path from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  createCompatibilityChecker,
  type CompatibilityChecker,
  type CompatibilityResult,
} from "./compatibility.ts";
import {
  createFilePreferenceStore,
  isLiveVoice,
  LIVE_VOICE_VALUES,
  PreferenceError,
  type PreferenceStore,
} from "./preferences.ts";

export type LiveState =
  | "off"
  | "consent"
  | "acquiring"
  | "connecting"
  | "active"
  | "stopping"
  | "releasing"
  | "blocked";

export type LiveDiagnostic =
  | "busy"
  | "missing-auth"
  | "denied"
  | "connect-timeout"
  | "protocol-error"
  | "audio-error"
  | "cleanup-blocked";

export interface LiveSnapshot {
  state: LiveState;
  muted: boolean;
  voice: string;
  lastFailure?: LiveDiagnostic;
}

export interface LiveAdmissionFacts {
  tui: boolean;
  compatible: boolean;
  conflict: boolean;
  dialog: boolean;
  idle: boolean;
  pendingWork: boolean;
}

export interface OwnershipIdentity {
  dev: string;
  ino: string;
  uid: number;
  gid: number;
  mode: number;
  kind: "directory" | "file" | "symlink" | "other";
}

export interface HomeCertificationObservation {
  canonicalHome: string;
  stateParent: string;
  homeIdentity: OwnershipIdentity;
  stateParentIdentity: OwnershipIdentity;
}

export type HomeCertificationResult =
  ({ certified: true } & HomeCertificationObservation) | { certified: false };

export interface HomeAuthority {
  accountHome(): string;
  environmentHome(): string | undefined;
  certify(
    observation: HomeCertificationObservation,
  ): HomeCertificationResult | Promise<HomeCertificationResult>;
}

export interface OwnershipFileHandle {
  write(bytes: Uint8Array): Promise<void>;
  sync(): Promise<void>;
  inspect(): Promise<OwnershipIdentity>;
  close(): Promise<void>;
}

export interface OwnershipFileSystem {
  realpath(target: string): Promise<string>;
  inspect(target: string): Promise<OwnershipIdentity>;
  mkdirExclusive(target: string, mode: number): Promise<void>;
  openOwner(target: string, mode: number): Promise<OwnershipFileHandle>;
  read(target: string, maxBytes: number): Promise<Uint8Array>;
  entries(target: string): Promise<string[]>;
  unlink(target: string): Promise<void>;
  rmdir(target: string): Promise<void>;
}

export interface LiveResourceStart<T> {
  result: Promise<T>;
  terminate(dispose: (resource: T) => Promise<void>): Promise<void>;
}

export interface LiveCapture {
  stop(): Promise<void>;
}

export type LiveOutgoingData =
  { kind: "application"; text: string } | { kind: "final"; text: string };

export interface LiveSessionCloseRequest {
  signal: AbortSignal;
  deadline: number;
  remainingMs: number;
}

export interface LiveConnection {
  startCapture(
    onSample: (samples: readonly number[]) => void,
  ): LiveResourceStart<LiveCapture>;
  sendSample(samples: readonly number[]): void | Promise<void>;
  sendData?(data: LiveOutgoingData): void | Promise<void>;
  closeSession(request: LiveSessionCloseRequest): void | Promise<void>;
  close(): Promise<void>;
}

export interface LiveResources {
  credentials(input: { signal: AbortSignal }): Promise<void>;
  attestation(input: { signal: AbortSignal }): Promise<void>;
  connect(input: { signal: AbortSignal }): LiveResourceStart<LiveConnection>;
}

export type LiveTimer = object;

export interface LiveClock {
  now(): number;
  setTimer(callback: () => void, delayMs: number): LiveTimer;
  clearTimer(timer: LiveTimer): void;
}

export type LiveCoordinationOwnership =
  | { kind: "none" }
  | { kind: "pending"; attemptId: string }
  | { kind: "blocked" };

export interface LiveCoordination {
  version: 1;
  poolingRefused: boolean;
  ownership: LiveCoordinationOwnership;
}

export function createIsolatedLiveCoordination(): LiveCoordination {
  return { version: 1, poolingRefused: false, ownership: { kind: "none" } };
}

export type LiveInterruptionReason =
  | "lifecycle-change"
  | "reported-dialog"
  | "observed-conflict"
  | "expiry"
  | "failure"
  | "pooling";

export interface LiveLifecycleOptions {
  initialVoice?: string;
  admission?: {
    check(): LiveAdmissionFacts | Promise<LiveAdmissionFacts>;
  };
  consent?: {
    request(input: {
      generation: string;
      voice: string;
      signal: AbortSignal;
    }): Promise<boolean>;
  };
  home?: HomeAuthority;
  ownershipFileSystem?: OwnershipFileSystem;
  resources?: LiveResources;
  clock?: LiveClock;
  randomId?: () => string;
  coordination?: LiveCoordination;
}

export type LiveStartResult =
  | { kind: "refused"; state: LiveState; diagnostic: LiveDiagnostic }
  | { kind: "existing"; state: LiveState }
  | { kind: "cancelled"; state: LiveState }
  | { kind: "started"; state: "active" };

export type LiveMutationResult =
  | {
      kind: "updated";
      state: LiveState;
      muted?: boolean;
      voice?: string;
    }
  | { kind: "unchanged"; state: LiveState; muted?: boolean }
  | { kind: "refused"; state: LiveState; diagnostic: LiveDiagnostic };

export type LiveStopResult = {
  status: "off" | "blocked" | "release-pending";
};

export type LiveOutgoingSender = (data: LiveOutgoingData) => boolean;

export type LiveDelegationAdmissionResult =
  | { kind: "updated"; state: "active"; settle(): void }
  | { kind: "refused"; state: LiveState; diagnostic: LiveDiagnostic };

export interface LiveLifecycle {
  snapshot(): LiveSnapshot;
  createOutgoingSender(): LiveOutgoingSender | undefined;
  start(): Promise<LiveStartResult>;
  toggle(): Promise<LiveStartResult | LiveStopResult>;
  stop(): Promise<LiveStopResult>;
  setMuted(muted: boolean): Promise<LiveMutationResult>;
  selectVoice(voice: string): Promise<LiveMutationResult>;
  interrupt(reason: LiveInterruptionReason): Promise<LiveStopResult>;
  delegationAdmitted(): LiveDelegationAdmissionResult;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

interface CertifiedHome extends HomeCertificationObservation {
  lockPath: string;
}

interface PublishedOwner {
  home: CertifiedHome;
  lockIdentity: OwnershipIdentity;
  ownerIdentity: OwnershipIdentity;
  ownerPath: string;
  bytes: Uint8Array;
}

interface ResourceObligation {
  quiesce(): Promise<void>;
}

interface CallAttempt {
  generation: string;
  releaseId: string;
  voice: string;
  controller: AbortController;
  cancelled: Deferred<void>;
  timers: Set<LiveTimer>;
  connectDeadline?: number;
  callDeadline?: number;
  connectTimer?: LiveTimer;
  callTimer?: LiveTimer;
  stopDeadline?: number;
  stopObservation?: Deferred<LiveStopResult>;
  stopTimer?: LiveTimer;
  cleanupStarted: boolean;
  cleanupPromise?: Promise<void>;
  acquisitionDone?: Deferred<void>;
  owner?: PublishedOwner;
  obligations: Set<ResourceObligation>;
  connection?: LiveConnection;
  capture?: LiveCapture;
  captureToken?: object;
  captureTransition?: Promise<void>;
  muted: boolean;
  deliveryFenced: boolean;
  closeSent: boolean;
  closeController?: AbortController;
  delegation?: { token: object; timer?: LiveTimer; deadline: number };
}

const DEFAULT_ADMISSION: LiveAdmissionFacts = {
  tui: false,
  compatible: false,
  conflict: false,
  dialog: false,
  idle: true,
  pendingWork: false,
};
const CONNECT_MS = 30_000;
const DATA_PHASE_MS = 5_000;
const RESOURCE_PHASE_MS = 10_000;
const STOP_MS = 5_000;
const CALL_MS = 60 * 60_000;
const DELEGATION_MS = 30 * 60_000;
const OWNER_RECORD_LIMIT = 4_096;
const GLOBAL_COORDINATION_KEY = "__pi_live_lifecycle_coordination_v1__";

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value: T): void {
      resolvePromise?.(value);
    },
  };
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

function identitiesEqual(
  left: OwnershipIdentity,
  right: OwnershipIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.mode === right.mode &&
    left.kind === right.kind
  );
}

function identityFromStat(info: Stats): OwnershipIdentity {
  return {
    dev: String(info.dev),
    ino: String(info.ino),
    uid: info.uid,
    gid: info.gid,
    mode: info.mode & 0o7777,
    kind: info.isDirectory()
      ? "directory"
      : info.isFile()
        ? "file"
        : info.isSymbolicLink()
          ? "symlink"
          : "other",
  };
}

function nodeHandle(handle: FileHandle): OwnershipFileHandle {
  return {
    async write(bytes: Uint8Array): Promise<void> {
      await handle.writeFile(bytes);
    },
    async sync(): Promise<void> {
      await handle.sync();
    },
    async inspect(): Promise<OwnershipIdentity> {
      return identityFromStat(await handle.stat());
    },
    async close(): Promise<void> {
      await handle.close();
    },
  };
}

export function createNodeOwnershipFileSystem(): OwnershipFileSystem {
  return {
    realpath,
    async inspect(target: string): Promise<OwnershipIdentity> {
      return identityFromStat(await lstat(target));
    },
    async mkdirExclusive(target: string, mode: number): Promise<void> {
      await mkdir(target, { mode });
    },
    async openOwner(
      target: string,
      mode: number,
    ): Promise<OwnershipFileHandle> {
      const handle = await open(
        target,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        mode,
      );
      return nodeHandle(handle);
    },
    async read(target: string, maxBytes: number): Promise<Uint8Array> {
      if (
        !Number.isSafeInteger(maxBytes) ||
        maxBytes < 0 ||
        maxBytes > OWNER_RECORD_LIMIT
      )
        throw new Error("invalid owner read bound");
      const handle = await open(
        target,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > maxBytes)
          throw new Error("owner record exceeds read bound");
        const bytes = Buffer.alloc(maxBytes + 1);
        let length = 0;
        while (length < bytes.byteLength) {
          const result = await handle.read(
            bytes,
            length,
            bytes.byteLength - length,
            null,
          );
          if (result.bytesRead === 0) break;
          length += result.bytesRead;
        }
        if (length > maxBytes)
          throw new Error("owner record exceeds read bound");
        return bytes.subarray(0, length);
      } finally {
        await handle.close();
      }
    },
    entries: readdir,
    unlink,
    rmdir,
  };
}

function defaultClock(): LiveClock {
  return {
    now: () => performance.now(),
    setTimer(callback, delayMs) {
      return setTimeout(callback, Math.max(0, delayMs));
    },
    clearTimer(timer) {
      clearTimeout(timer as NodeJS.Timeout);
    },
  };
}

function validCoordination(value: unknown): value is LiveCoordination {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.poolingRefused !== "boolean")
    return false;
  const ownership = record.ownership;
  if (
    ownership === null ||
    typeof ownership !== "object" ||
    Array.isArray(ownership)
  )
    return false;
  const state = ownership as Record<string, unknown>;
  return (
    state.kind === "none" ||
    state.kind === "blocked" ||
    (state.kind === "pending" && typeof state.attemptId === "string")
  );
}

function processCoordination(): LiveCoordination | undefined {
  const globals = globalThis as typeof globalThis & Record<string, unknown>;
  const existing = globals[GLOBAL_COORDINATION_KEY];
  if (existing === undefined) {
    const created = createIsolatedLiveCoordination();
    globals[GLOBAL_COORDINATION_KEY] = created;
    return created;
  }
  return validCoordination(existing) ? existing : undefined;
}

function certificationMatches(
  result: HomeCertificationResult,
  observation: HomeCertificationObservation,
): result is { certified: true } & HomeCertificationObservation {
  return (
    result.certified &&
    result.canonicalHome === observation.canonicalHome &&
    result.stateParent === observation.stateParent &&
    identitiesEqual(result.homeIdentity, observation.homeIdentity) &&
    identitiesEqual(result.stateParentIdentity, observation.stateParentIdentity)
  );
}

function admissionDiagnostic(
  facts: LiveAdmissionFacts,
): LiveDiagnostic | undefined {
  if (facts.conflict || facts.dialog || !facts.idle || facts.pendingWork)
    return "busy";
  if (!facts.tui || !facts.compatible) return "denied";
  return undefined;
}

export function createLiveLifecycle(
  options: LiveLifecycleOptions = {},
): LiveLifecycle {
  const clock = options.clock ?? defaultClock();
  const ownershipFs =
    options.ownershipFileSystem ?? createNodeOwnershipFileSystem();
  const randomId = options.randomId ?? randomUUID;
  const home: HomeAuthority =
    options.home ??
    ({
      accountHome: () => userInfo().homedir,
      environmentHome: () => process.env.HOME,
      certify: () => ({ certified: false }),
    } satisfies HomeAuthority);
  const resources: LiveResources =
    options.resources ??
    ({
      credentials: async () => {
        throw new Error("unavailable");
      },
      attestation: async () => {
        throw new Error("unavailable");
      },
      connect: () => {
        throw new Error("unavailable");
      },
    } satisfies LiveResources);
  const coordination = options.coordination ?? processCoordination();
  let state: LiveState = coordination ? "off" : "blocked";
  let lastFailure: LiveDiagnostic | undefined = coordination
    ? undefined
    : "cleanup-blocked";
  let voice = isLiveVoice(options.initialVoice) ? options.initialVoice : "sol";
  let attempt: CallAttempt | undefined;
  let projectedPending: string | undefined;

  function sharedContinuationAllowed(current: CallAttempt): boolean {
    if (
      coordination &&
      validCoordination(coordination) &&
      !coordination.poolingRefused &&
      coordination.ownership.kind === "none"
    )
      return true;
    if (attempt !== current) return false;
    if (
      current.owner ||
      current.acquisitionDone ||
      current.obligations.size > 0 ||
      current.connection ||
      current.capture ||
      current.captureTransition
    ) {
      if (state !== "stopping" && state !== "releasing" && state !== "blocked")
        void beginStop(
          current,
          coordination?.ownership.kind === "blocked"
            ? "cleanup-blocked"
            : undefined,
        );
      return false;
    }

    current.deliveryFenced = true;
    current.captureToken = undefined;
    attempt = undefined;
    if (!coordination || !validCoordination(coordination)) {
      state = "blocked";
      lastFailure = "cleanup-blocked";
    } else if (coordination.ownership.kind === "pending") {
      projectedPending = coordination.ownership.attemptId;
      state = "releasing";
    } else if (coordination.ownership.kind === "blocked") {
      state = "blocked";
      lastFailure = "cleanup-blocked";
    } else {
      state = "off";
      lastFailure = "denied";
    }
    current.controller.abort();
    current.cancelled.resolve();
    clearAttemptTimers(current);
    return false;
  }

  if (coordination?.ownership.kind === "pending") {
    state = "releasing";
    projectedPending = coordination.ownership.attemptId;
  } else if (coordination?.ownership.kind === "blocked") {
    state = "blocked";
    lastFailure = "cleanup-blocked";
  }

  function refreshProjection(observeContinuation = true): void {
    if (!coordination) return;
    if (projectedPending !== undefined) {
      if (
        coordination.ownership.kind === "pending" &&
        coordination.ownership.attemptId === projectedPending
      ) {
        state = "releasing";
        return;
      }
      projectedPending = undefined;
      if (coordination.ownership.kind === "blocked") {
        state = "blocked";
        lastFailure = "cleanup-blocked";
      } else {
        state = "off";
      }
    }
    if (attempt !== undefined) {
      if (!observeContinuation) return;
      if (
        state !== "stopping" &&
        state !== "releasing" &&
        state !== "blocked" &&
        !sharedContinuationAllowed(attempt)
      )
        return;
      if (
        state !== "stopping" &&
        state !== "releasing" &&
        state !== "blocked"
      ) {
        if (
          attempt.callDeadline !== undefined &&
          clock.now() >= attempt.callDeadline
        )
          void beginStop(attempt);
        else if (
          attempt.delegation !== undefined &&
          clock.now() >= attempt.delegation.deadline
        ) {
          attempt.delegation = undefined;
          void beginStop(attempt);
        } else if (
          (state === "acquiring" || state === "connecting") &&
          attempt.connectDeadline !== undefined &&
          clock.now() >= attempt.connectDeadline
        )
          void beginStop(attempt, "connect-timeout");
      }
      return;
    }
    if (coordination.ownership.kind === "pending") {
      projectedPending = coordination.ownership.attemptId;
      state = "releasing";
    } else if (coordination.ownership.kind === "blocked") {
      state = "blocked";
      lastFailure = "cleanup-blocked";
    }
  }

  function snapshot(): LiveSnapshot {
    // Project release settlement without starting cleanup from a status read.
    refreshProjection(false);
    return {
      state,
      muted: attempt?.muted ?? false,
      voice,
      ...(lastFailure === undefined ? {} : { lastFailure }),
    };
  }

  function schedule(
    current: CallAttempt,
    delayMs: number,
    callback: () => void,
  ): LiveTimer {
    let timer: LiveTimer;
    timer = clock.setTimer(
      () => {
        current.timers.delete(timer);
        callback();
      },
      Math.max(0, delayMs),
    );
    current.timers.add(timer);
    return timer;
  }

  function clearAttemptTimer(current: CallAttempt, timer?: LiveTimer): void {
    if (!timer) return;
    if (current.timers.delete(timer)) clock.clearTimer(timer);
  }

  function clearAttemptTimers(current: CallAttempt): void {
    for (const timer of current.timers) clock.clearTimer(timer);
    current.timers.clear();
  }

  async function checkAdmission(): Promise<LiveAdmissionFacts> {
    try {
      return await (options.admission?.check() ?? DEFAULT_ADMISSION);
    } catch {
      return DEFAULT_ADMISSION;
    }
  }

  async function resolveCertifiedHome(
    current: CallAttempt,
  ): Promise<CertifiedHome | undefined> {
    const mayInspect = () =>
      currentAttempt(current) &&
      state === "acquiring" &&
      sharedContinuationAllowed(current);
    try {
      if (!mayInspect()) return undefined;
      const canonicalHome = await ownershipFs.realpath(home.accountHome());
      if (!mayInspect()) return undefined;
      const environmentHome = home.environmentHome();
      if (environmentHome !== undefined) {
        const canonicalEnvironmentHome =
          await ownershipFs.realpath(environmentHome);
        if (!mayInspect() || canonicalEnvironmentHome !== canonicalHome)
          return undefined;
      }
      const stateParent = path.join(canonicalHome, ".local/state/pi-live");
      const canonicalStateParent = await ownershipFs.realpath(stateParent);
      if (!mayInspect() || canonicalStateParent !== stateParent)
        return undefined;
      const expectedUid = process.getuid?.();
      for (const directory of [
        canonicalHome,
        path.join(canonicalHome, ".local"),
        path.join(canonicalHome, ".local/state"),
        stateParent,
      ]) {
        const canonicalDirectory = await ownershipFs.realpath(directory);
        if (!mayInspect() || canonicalDirectory !== directory) return undefined;
        const identity = await ownershipFs.inspect(directory);
        if (
          !mayInspect() ||
          identity.kind !== "directory" ||
          (expectedUid !== undefined && identity.uid !== expectedUid)
        )
          return undefined;
      }
      const homeIdentity = await ownershipFs.inspect(canonicalHome);
      if (!mayInspect()) return undefined;
      const stateParentIdentity = await ownershipFs.inspect(stateParent);
      if (
        !mayInspect() ||
        stateParentIdentity.mode !== 0o700 ||
        (expectedUid !== undefined &&
          (homeIdentity.uid !== expectedUid ||
            stateParentIdentity.uid !== expectedUid))
      )
        return undefined;
      const observation: HomeCertificationObservation = {
        canonicalHome,
        stateParent,
        homeIdentity,
        stateParentIdentity,
      };
      const certificate = await home.certify(observation);
      if (!mayInspect() || !certificationMatches(certificate, observation))
        return undefined;
      const recheckedHome = await ownershipFs.realpath(canonicalHome);
      if (!mayInspect() || recheckedHome !== canonicalHome) return undefined;
      const recheckedStateParent = await ownershipFs.realpath(stateParent);
      if (!mayInspect() || recheckedStateParent !== stateParent)
        return undefined;
      const recheckedHomeIdentity = await ownershipFs.inspect(canonicalHome);
      if (
        !mayInspect() ||
        !identitiesEqual(recheckedHomeIdentity, homeIdentity)
      )
        return undefined;
      const recheckedStateParentIdentity =
        await ownershipFs.inspect(stateParent);
      if (
        !mayInspect() ||
        !identitiesEqual(recheckedStateParentIdentity, stateParentIdentity)
      )
        return undefined;
      return {
        ...observation,
        lockPath: path.join(stateParent, "active.lock"),
      };
    } catch {
      return undefined;
    }
  }

  async function acquireOwner(
    current: CallAttempt,
    certified: CertifiedHome,
  ): Promise<
    | { kind: "owned"; owner: PublishedOwner }
    | { kind: "busy" | "denied" | "blocked" }
  > {
    let created = false;
    let handle: OwnershipFileHandle | undefined;
    let closeAttempted = false;
    try {
      await ownershipFs.mkdirExclusive(certified.lockPath, 0o700);
      created = true;
      const lockIdentity = await ownershipFs.inspect(certified.lockPath);
      if (
        lockIdentity.kind !== "directory" ||
        lockIdentity.mode !== 0o700 ||
        lockIdentity.uid !== certified.stateParentIdentity.uid
      )
        throw new Error("unsafe lock");
      const ownerPath = path.join(certified.lockPath, "owner.json");
      const bytes = Buffer.from(
        `${JSON.stringify({
          version: 1,
          generation: current.generation,
          ownerToken: randomId(),
          pid: process.pid,
        })}\n`,
      );
      if (bytes.byteLength > OWNER_RECORD_LIMIT)
        throw new Error("owner record too large");
      handle = await ownershipFs.openOwner(ownerPath, 0o600);
      await handle.write(bytes);
      await handle.sync();
      const openedIdentity = await handle.inspect();
      if (
        openedIdentity.kind !== "file" ||
        openedIdentity.mode !== 0o600 ||
        openedIdentity.uid !== lockIdentity.uid
      )
        throw new Error("unsafe owner record");
      closeAttempted = true;
      await handle.close();
      handle = undefined;
      const ownerIdentity = await ownershipFs.inspect(ownerPath);
      if (!identitiesEqual(ownerIdentity, openedIdentity))
        throw new Error("owner record changed");
      const verified = await ownershipFs.read(ownerPath, OWNER_RECORD_LIMIT);
      if (
        !Buffer.from(verified).equals(bytes) ||
        !identitiesEqual(await ownershipFs.inspect(ownerPath), ownerIdentity)
      )
        throw new Error("owner record changed");
      if (
        !identitiesEqual(
          await ownershipFs.inspect(certified.lockPath),
          lockIdentity,
        ) ||
        (await ownershipFs.entries(certified.lockPath)).join("\u0000") !==
          "owner.json"
      )
        throw new Error("lock changed during publication");
      return {
        kind: "owned",
        owner: {
          home: certified,
          lockIdentity,
          ownerIdentity,
          ownerPath,
          bytes,
        },
      };
    } catch (error) {
      if (handle && !closeAttempted)
        await handle.close().catch(() => undefined);
      if (created) return { kind: "blocked" };
      if (errorCode(error) === "EEXIST") return { kind: "busy" };
      try {
        await ownershipFs.inspect(certified.lockPath);
        return { kind: "blocked" };
      } catch (inspectionError) {
        return errorCode(inspectionError) === "ENOENT"
          ? { kind: "denied" }
          : { kind: "blocked" };
      }
    }
  }

  async function validateOwner(owner: PublishedOwner): Promise<void> {
    if (
      (await ownershipFs.realpath(owner.home.canonicalHome)) !==
        owner.home.canonicalHome ||
      (await ownershipFs.realpath(owner.home.stateParent)) !==
        owner.home.stateParent ||
      !identitiesEqual(
        await ownershipFs.inspect(owner.home.canonicalHome),
        owner.home.homeIdentity,
      ) ||
      !identitiesEqual(
        await ownershipFs.inspect(owner.home.stateParent),
        owner.home.stateParentIdentity,
      ) ||
      !identitiesEqual(
        await ownershipFs.inspect(owner.home.lockPath),
        owner.lockIdentity,
      ) ||
      !identitiesEqual(
        await ownershipFs.inspect(owner.ownerPath),
        owner.ownerIdentity,
      ) ||
      !Buffer.from(
        await ownershipFs.read(owner.ownerPath, OWNER_RECORD_LIMIT),
      ).equals(owner.bytes) ||
      !identitiesEqual(
        await ownershipFs.inspect(owner.ownerPath),
        owner.ownerIdentity,
      ) ||
      (await ownershipFs.entries(owner.home.lockPath)).join("\u0000") !==
        "owner.json"
    )
      throw new Error("ownership changed");
  }

  async function releaseOwner(owner: PublishedOwner): Promise<void> {
    await validateOwner(owner);
    await ownershipFs.unlink(owner.ownerPath);
    if (
      !identitiesEqual(
        await ownershipFs.inspect(owner.home.lockPath),
        owner.lockIdentity,
      ) ||
      (await ownershipFs.entries(owner.home.lockPath)).length !== 0
    )
      throw new Error("lock changed during release");
    await ownershipFs.rmdir(owner.home.lockPath);
  }

  function finishRefusal(
    current: CallAttempt,
    diagnostic: LiveDiagnostic,
  ): LiveStartResult {
    if (attempt === current) attempt = undefined;
    state = "off";
    lastFailure = diagnostic;
    clearAttemptTimers(current);
    return { kind: "refused", state, diagnostic };
  }

  function currentAttempt(current: CallAttempt): boolean {
    return attempt === current && !current.controller.signal.aborted;
  }

  type WaitResult<T> =
    | { kind: "value"; value: T }
    | { kind: "error" }
    | { kind: "cancelled" }
    | { kind: "timeout" };

  async function waitFor<T>(
    current: CallAttempt,
    source: Promise<T> | (() => Promise<T>),
    deadline: number,
    timeoutDiagnostic: LiveDiagnostic = "connect-timeout",
  ): Promise<WaitResult<T>> {
    let promise = typeof source === "function" ? undefined : source;
    const stopForTimeout = (): WaitResult<T> => {
      if (promise) void promise.catch(() => undefined);
      void beginStop(current, timeoutDiagnostic);
      return { kind: "timeout" };
    };
    if (clock.now() >= deadline) return stopForTimeout();

    const timed = deferred<WaitResult<T>>();
    let timer: LiveTimer;
    const observeDeadline = () => {
      if (clock.now() < deadline) {
        timer = schedule(current, deadline - clock.now(), observeDeadline);
        return;
      }
      timed.resolve(stopForTimeout());
    };
    timer = schedule(current, deadline - clock.now(), observeDeadline);

    if (typeof source === "function") {
      if (!currentAttempt(current)) {
        clearAttemptTimer(current, timer);
        return { kind: "cancelled" };
      }
      if (clock.now() >= deadline) {
        clearAttemptTimer(current, timer);
        return stopForTimeout();
      }
      try {
        promise = source();
      } catch {
        clearAttemptTimer(current, timer);
        return { kind: "error" };
      }
    }

    const result = await Promise.race([
      promise!.then<WaitResult<T>, WaitResult<T>>(
        (value) => ({ kind: "value", value }),
        () => ({ kind: "error" }),
      ),
      current.cancelled.promise.then<WaitResult<T>>(() => ({
        kind: "cancelled",
      })),
      timed.promise,
    ]);
    clearAttemptTimer(current, timer);
    if (
      (result.kind === "value" || result.kind === "error") &&
      clock.now() >= deadline
    )
      return stopForTimeout();
    return result;
  }

  function trackedStart<T>(
    current: CallAttempt,
    invoke: () => LiveResourceStart<T>,
    dispose: (resource: T) => Promise<void>,
  ): { result: Promise<T>; adopt(): void; quiesce(): Promise<void> } {
    const invoked = deferred<void>();
    let started: LiveResourceStart<T> | undefined;
    let invocationError: unknown;
    let termination: Promise<void> | undefined;
    const obligation: ResourceObligation = {
      async quiesce(): Promise<void> {
        await invoked.promise;
        if (!started) throw invocationError;
        const startup = started;
        termination ??= Promise.resolve().then(() =>
          startup.terminate(dispose),
        );
        await termination;
      },
    };
    current.obligations.add(obligation);
    try {
      started = invoke();
      invoked.resolve();
    } catch (error) {
      invocationError = error;
      invoked.resolve();
      throw error;
    }
    return {
      result: started.result,
      adopt(): void {
        current.obligations.delete(obligation);
      },
      quiesce: () => obligation.quiesce(),
    };
  }

  function createOutgoingSender(): LiveOutgoingSender | undefined {
    refreshProjection();
    const current = attempt;
    const connection = current?.connection;
    const sendData = connection?.sendData;
    if (!current || !connection || !sendData || state !== "active")
      return undefined;
    return (data) => {
      if (attempt !== current) return false;
      refreshProjection();
      if (
        attempt !== current ||
        state !== "active" ||
        current.deliveryFenced ||
        !sharedContinuationAllowed(current) ||
        current.connection !== connection ||
        (data.kind !== "application" && data.kind !== "final") ||
        typeof data.text !== "string"
      )
        return false;
      try {
        const sent = sendData.call(connection, {
          kind: data.kind,
          text: data.text,
        });
        if (sent !== undefined)
          void Promise.resolve(sent).catch(() => {
            if (
              attempt === current &&
              state === "active" &&
              current.connection === connection
            )
              void beginStop(current, "protocol-error");
          });
      } catch {
        void beginStop(current, "protocol-error");
      }
      return true;
    };
  }

  function sampleHandler(
    current: CallAttempt,
    connection: LiveConnection,
    captureToken: object,
  ): (samples: readonly number[]) => void {
    return (samples) => {
      if (attempt !== current) return;
      refreshProjection();
      if (
        attempt !== current ||
        current.deliveryFenced ||
        current.muted ||
        !sharedContinuationAllowed(current) ||
        current.connection !== connection ||
        current.captureToken !== captureToken ||
        (state !== "connecting" && state !== "active")
      )
        return;
      try {
        const sent = connection.sendSample(samples);
        if (sent !== undefined)
          void Promise.resolve(sent).catch(() => {
            if (attempt === current) void beginStop(current, "audio-error");
          });
      } catch {
        void beginStop(current, "audio-error");
      }
    };
  }

  async function beginCapture(
    current: CallAttempt,
    totalDeadline: number,
  ): Promise<WaitResult<LiveCapture>> {
    if (
      !currentAttempt(current) ||
      current.muted ||
      !sharedContinuationAllowed(current) ||
      (state !== "connecting" && state !== "active")
    )
      return { kind: "cancelled" };
    const timeoutDiagnostic: LiveDiagnostic =
      state === "active" ? "audio-error" : "connect-timeout";
    const deadline = Math.min(
      totalDeadline,
      current.callDeadline ?? totalDeadline,
      clock.now() + RESOURCE_PHASE_MS,
    );
    if (clock.now() >= deadline) {
      void beginStop(current, timeoutDiagnostic);
      return { kind: "timeout" };
    }
    const connection = current.connection;
    if (!connection) return { kind: "error" };
    let tracked: ReturnType<typeof trackedStart<LiveCapture>>;
    const captureToken = {};
    current.captureToken = captureToken;
    try {
      tracked = trackedStart(
        current,
        () =>
          connection.startCapture(
            sampleHandler(current, connection, captureToken),
          ),
        (capture) => capture.stop(),
      );
    } catch {
      void beginStop(current, "audio-error");
      return { kind: "error" };
    }
    const result = await waitFor(
      current,
      tracked.result,
      deadline,
      timeoutDiagnostic,
    );
    if (
      result.kind === "value" &&
      currentAttempt(current) &&
      sharedContinuationAllowed(current) &&
      !current.muted &&
      (state === "connecting" || state === "active")
    ) {
      tracked.adopt();
      current.capture = result.value;
      return result;
    }
    if (current.captureToken === captureToken) current.captureToken = undefined;
    if (result.kind === "error") void beginStop(current, "audio-error");
    await tracked.quiesce().catch(() => {
      markBlocked(current);
    });
    return result.kind === "value" ? { kind: "cancelled" } : result;
  }

  function resolveStopObservation(
    current: CallAttempt,
    result: LiveStopResult,
  ): void {
    current.stopObservation?.resolve(result);
  }

  function markBlocked(current: CallAttempt): void {
    if (attempt !== current) return;
    if (
      state === "releasing" &&
      (!coordination ||
        coordination.ownership.kind !== "pending" ||
        coordination.ownership.attemptId !== current.releaseId)
    )
      return;
    current.deliveryFenced = true;
    current.captureToken = undefined;
    state = "blocked";
    lastFailure = "cleanup-blocked";
    if (
      coordination &&
      (coordination.ownership.kind !== "pending" ||
        coordination.ownership.attemptId === current.releaseId)
    )
      coordination.ownership = { kind: "blocked" };
    resolveStopObservation(current, { status: "blocked" });
    current.controller.abort();
    current.closeController?.abort();
    current.cancelled.resolve();
    clearAttemptTimers(current);
  }

  function observeStopDeadline(current: CallAttempt): void {
    if (attempt !== current) return;
    if (
      current.stopDeadline !== undefined &&
      clock.now() < current.stopDeadline
    ) {
      current.stopTimer = schedule(
        current,
        current.stopDeadline - clock.now(),
        () => observeStopDeadline(current),
      );
      return;
    }
    current.closeController?.abort();
    if (state === "stopping") {
      markBlocked(current);
    } else if (state === "releasing") {
      resolveStopObservation(current, { status: "release-pending" });
    } else if (state === "off") {
      resolveStopObservation(current, { status: "off" });
    } else if (state === "blocked") {
      resolveStopObservation(current, { status: "blocked" });
    }
  }

  function beginRelease(current: CallAttempt): void {
    if (
      attempt !== current ||
      state !== "stopping" ||
      !current.owner ||
      current.stopDeadline === undefined ||
      clock.now() >= current.stopDeadline ||
      coordination?.ownership.kind !== "none"
    ) {
      markBlocked(current);
      return;
    }
    state = "releasing";
    if (coordination)
      coordination.ownership = {
        kind: "pending",
        attemptId: current.releaseId,
      };
    const owner = current.owner;
    void releaseOwner(owner).then(
      () => {
        if (
          coordination?.ownership.kind !== "pending" ||
          coordination.ownership.attemptId !== current.releaseId
        )
          return;
        coordination.ownership = { kind: "none" };
        if (attempt === current && state === "releasing") {
          clearAttemptTimer(current, current.stopTimer);
          state = "off";
          attempt = undefined;
          resolveStopObservation(current, { status: "off" });
        }
      },
      () => {
        if (attempt === current && state === "releasing") markBlocked(current);
      },
    );
  }

  function invokeShutdown(effect: () => void | Promise<void>): Promise<void> {
    try {
      return Promise.resolve(effect());
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async function cleanupAttempt(current: CallAttempt): Promise<void> {
    if (current.acquisitionDone) await current.acquisitionDone.promise;
    const work: Promise<void>[] = [];
    if (current.captureTransition) work.push(current.captureTransition);
    for (const obligation of current.obligations)
      work.push(invokeShutdown(() => obligation.quiesce()));
    current.obligations.clear();
    if (current.capture) {
      const capture = current.capture;
      current.capture = undefined;
      work.push(invokeShutdown(() => capture.stop()));
    }
    if (current.connection) {
      const connection = current.connection;
      current.connection = undefined;
      work.push(invokeShutdown(() => connection.close()));
    }
    const settled = await Promise.allSettled(work);
    current.closeController?.abort();
    if (settled.some((result) => result.status === "rejected")) {
      markBlocked(current);
      return;
    }
    if (attempt !== current || state === "blocked") return;
    if (
      state !== "stopping" ||
      current.stopDeadline === undefined ||
      clock.now() >= current.stopDeadline
    ) {
      markBlocked(current);
      return;
    }
    if (!current.owner) {
      clearAttemptTimer(current, current.stopTimer);
      state = "off";
      attempt = undefined;
      resolveStopObservation(current, { status: "off" });
      return;
    }
    beginRelease(current);
  }

  function beginStop(
    current: CallAttempt,
    diagnostic?: LiveDiagnostic,
  ): Promise<LiveStopResult> {
    if (attempt !== current) {
      refreshProjection();
      return Promise.resolve({
        status:
          state === "blocked"
            ? "blocked"
            : state === "releasing"
              ? "release-pending"
              : "off",
      });
    }
    if (state === "blocked") return Promise.resolve({ status: "blocked" });
    if (state === "releasing") {
      return (
        current.stopObservation?.promise ??
        Promise.resolve({ status: "release-pending" })
      );
    }
    if (state === "stopping" && current.stopObservation)
      return current.stopObservation.promise;
    const stopDeadline = clock.now() + STOP_MS;
    const stopObservation = deferred<LiveStopResult>();
    current.deliveryFenced = true;
    current.captureToken = undefined;
    if (diagnostic !== undefined) lastFailure = diagnostic;
    current.stopDeadline = stopDeadline;
    current.stopObservation = stopObservation;
    state = "stopping";
    current.delegation = undefined;
    current.controller.abort();
    current.cancelled.resolve();
    clearAttemptTimers(current);
    current.stopTimer = schedule(
      current,
      Math.max(0, stopDeadline - clock.now()),
      () => observeStopDeadline(current),
    );
    if (current.connection && !current.closeSent) {
      current.closeSent = true;
      current.closeController = new AbortController();
      const request: LiveSessionCloseRequest = {
        signal: current.closeController.signal,
        deadline: current.stopDeadline,
        remainingMs: Math.max(0, current.stopDeadline - clock.now()),
      };
      try {
        const close = current.connection.closeSession(request);
        if (close !== undefined)
          void Promise.resolve(close).catch(() => undefined);
      } catch {
        // The fixed semantic close is best effort and never delays local cleanup.
      }
    }
    if (!current.cleanupStarted) {
      current.cleanupStarted = true;
      current.cleanupPromise = cleanupAttempt(current).catch(() => {
        markBlocked(current);
      });
    }
    return current.stopObservation.promise;
  }

  async function reconcileCapture(current: CallAttempt): Promise<void> {
    for (;;) {
      if (attempt !== current || state !== "active") return;
      if (current.muted) {
        if (!current.capture) return;
        const capture = current.capture;
        current.capture = undefined;
        current.captureToken = undefined;
        try {
          await capture.stop();
        } catch {
          void beginStop(current, "audio-error");
          throw new Error("capture stop failed");
        }
        continue;
      }
      if (current.capture) return;
      if (!sharedContinuationAllowed(current)) return;
      const facts = await checkAdmission();
      if (
        attempt !== current ||
        state !== "active" ||
        !sharedContinuationAllowed(current)
      )
        return;
      if (admissionDiagnostic(facts) !== undefined || !current.owner) {
        void beginStop(current, "denied");
        return;
      }
      try {
        await validateOwner(current.owner);
      } catch {
        void beginStop(current, "cleanup-blocked");
        markBlocked(current);
        return;
      }
      if (
        attempt !== current ||
        state !== "active" ||
        !sharedContinuationAllowed(current)
      )
        return;
      if (current.muted) continue;
      const deadline = Math.min(
        current.callDeadline ?? clock.now() + RESOURCE_PHASE_MS,
        clock.now() + RESOURCE_PHASE_MS,
      );
      const result = await beginCapture(current, deadline);
      if (result.kind !== "value") return;
    }
  }

  async function setMuted(muted: boolean): Promise<LiveMutationResult> {
    refreshProjection();
    const current = attempt;
    if (!current || state !== "active")
      return { kind: "refused", state, diagnostic: "busy" };
    if (current.muted === muted) return { kind: "unchanged", state, muted };
    current.muted = muted;
    if (!current.captureTransition) {
      let resolveTransition!: () => void;
      let rejectTransition!: (error: unknown) => void;
      const transition = new Promise<void>((resolve, reject) => {
        resolveTransition = resolve;
        rejectTransition = reject;
      });
      current.captureTransition = transition;
      void reconcileCapture(current).then(
        () => {
          if (current.captureTransition === transition)
            current.captureTransition = undefined;
          resolveTransition();
        },
        (error: unknown) => {
          if (current.captureTransition === transition)
            current.captureTransition = undefined;
          rejectTransition(error);
        },
      );
    }
    const transition = current.captureTransition;
    try {
      await transition;
    } catch {
      // The shared stop path records the fixed diagnostic.
    }
    if (attempt !== current || state !== "active")
      return {
        kind: "refused",
        state,
        diagnostic: lastFailure ?? "audio-error",
      };
    return { kind: "updated", state, muted: current.muted };
  }

  async function start(): Promise<LiveStartResult> {
    refreshProjection();
    if (!coordination)
      return {
        kind: "refused",
        state: "blocked",
        diagnostic: "cleanup-blocked",
      };
    if (state !== "off") {
      if (
        state === "consent" ||
        state === "acquiring" ||
        state === "connecting" ||
        state === "active"
      )
        return { kind: "existing", state };
      return {
        kind: "refused",
        state,
        diagnostic: state === "blocked" ? "cleanup-blocked" : "busy",
      };
    }
    if (coordination.poolingRefused) {
      lastFailure = "denied";
      return { kind: "refused", state, diagnostic: "denied" };
    }
    const current: CallAttempt = {
      generation: randomId(),
      releaseId: randomId(),
      voice,
      controller: new AbortController(),
      cancelled: deferred<void>(),
      timers: new Set(),
      cleanupStarted: false,
      obligations: new Set(),
      muted: false,
      deliveryFenced: false,
      closeSent: false,
    };
    attempt = current;
    state = "consent";
    if (!sharedContinuationAllowed(current))
      return { kind: "cancelled", state };
    const beforeConsent = await checkAdmission();
    if (!currentAttempt(current) || !sharedContinuationAllowed(current))
      return { kind: "cancelled", state };
    const initialDiagnostic = admissionDiagnostic(beforeConsent);
    if (initialDiagnostic) return finishRefusal(current, initialDiagnostic);
    let accepted = false;
    if (!sharedContinuationAllowed(current))
      return { kind: "cancelled", state };
    try {
      accepted = await (options.consent?.request({
        generation: current.generation,
        voice: current.voice,
        signal: current.controller.signal,
      }) ?? Promise.resolve(false));
    } catch {
      accepted = false;
    }
    if (!currentAttempt(current) || !sharedContinuationAllowed(current))
      return { kind: "cancelled", state };
    if (!accepted) return finishRefusal(current, "denied");
    if (!sharedContinuationAllowed(current))
      return { kind: "cancelled", state };
    const afterConsent = await checkAdmission();
    if (!currentAttempt(current) || !sharedContinuationAllowed(current))
      return { kind: "cancelled", state };
    const consentDiagnostic = admissionDiagnostic(afterConsent);
    if (consentDiagnostic) return finishRefusal(current, consentDiagnostic);
    if (!sharedContinuationAllowed(current))
      return { kind: "cancelled", state };

    state = "acquiring";
    current.connectDeadline = clock.now() + CONNECT_MS;
    current.callDeadline = clock.now() + CALL_MS;
    const observeConnectDeadline = () => {
      current.connectTimer = undefined;
      if (attempt !== current || state === "active") return;
      if (clock.now() < current.connectDeadline!) {
        current.connectTimer = schedule(
          current,
          current.connectDeadline! - clock.now(),
          observeConnectDeadline,
        );
        return;
      }
      void beginStop(current, "connect-timeout");
    };
    current.connectTimer = schedule(
      current,
      CONNECT_MS,
      observeConnectDeadline,
    );
    const observeCallDeadline = () => {
      current.callTimer = undefined;
      if (attempt !== current) return;
      if (clock.now() < current.callDeadline!) {
        current.callTimer = schedule(
          current,
          current.callDeadline! - clock.now(),
          observeCallDeadline,
        );
        return;
      }
      void beginStop(current);
    };
    current.callTimer = schedule(current, CALL_MS, observeCallDeadline);

    const certified = await resolveCertifiedHome(current);
    refreshProjection();
    if (!currentAttempt(current)) return { kind: "cancelled", state };
    if (!certified) return finishRefusal(current, "denied");
    if (!sharedContinuationAllowed(current))
      return { kind: "cancelled", state };
    current.acquisitionDone = deferred<void>();
    const acquisition = await acquireOwner(current, certified);
    if (acquisition.kind === "owned") current.owner = acquisition.owner;
    current.acquisitionDone.resolve();
    current.acquisitionDone = undefined;
    if (acquisition.kind === "blocked") {
      void beginStop(current, "cleanup-blocked");
      markBlocked(current);
      return { kind: "cancelled", state: "blocked" };
    }
    refreshProjection();
    if (acquisition.kind !== "owned") {
      if (!currentAttempt(current)) return { kind: "cancelled", state };
      return finishRefusal(
        current,
        acquisition.kind === "busy" ? "busy" : "denied",
      );
    }
    if (!currentAttempt(current)) {
      await current.cleanupPromise;
      return { kind: "cancelled", state };
    }

    const credentialDeadline = Math.min(
      current.connectDeadline,
      current.callDeadline!,
      clock.now() + DATA_PHASE_MS,
    );
    const credentialResult = await waitFor(
      current,
      () => {
        if (
          !currentAttempt(current) ||
          state !== "acquiring" ||
          !sharedContinuationAllowed(current)
        )
          throw new Error("call attempt fenced");
        return resources.credentials({ signal: current.controller.signal });
      },
      credentialDeadline,
    );
    if (credentialResult.kind !== "value") {
      if (credentialResult.kind === "error")
        void beginStop(current, "missing-auth");
      return { kind: "cancelled", state };
    }
    if (!currentAttempt(current) || state !== "acquiring")
      return { kind: "cancelled", state };
    const attestationDeadline = Math.min(
      current.connectDeadline,
      current.callDeadline!,
      clock.now() + DATA_PHASE_MS,
    );
    const attestationResult = await waitFor(
      current,
      () => {
        if (
          !currentAttempt(current) ||
          state !== "acquiring" ||
          !sharedContinuationAllowed(current)
        )
          throw new Error("call attempt fenced");
        return resources.attestation({ signal: current.controller.signal });
      },
      attestationDeadline,
    );
    if (attestationResult.kind !== "value") {
      if (attestationResult.kind === "error")
        void beginStop(current, "protocol-error");
      return { kind: "cancelled", state };
    }
    if (!currentAttempt(current) || state !== "acquiring")
      return { kind: "cancelled", state };

    if (!sharedContinuationAllowed(current))
      return { kind: "cancelled", state };
    state = "connecting";
    const connectionDeadline = Math.min(
      current.connectDeadline,
      current.callDeadline!,
      clock.now() + RESOURCE_PHASE_MS,
    );
    if (clock.now() >= connectionDeadline) {
      void beginStop(current, "connect-timeout");
      return { kind: "cancelled", state };
    }
    let connectionStart: ReturnType<typeof trackedStart<LiveConnection>>;
    try {
      connectionStart = trackedStart(
        current,
        () => resources.connect({ signal: current.controller.signal }),
        (connection) => connection.close(),
      );
    } catch {
      void beginStop(current, "protocol-error");
      return { kind: "cancelled", state };
    }
    const connectionResult = await waitFor(
      current,
      connectionStart.result,
      connectionDeadline,
    );
    if (
      connectionResult.kind !== "value" ||
      !currentAttempt(current) ||
      !sharedContinuationAllowed(current)
    ) {
      if (connectionResult.kind === "error")
        void beginStop(current, "protocol-error");
      await connectionStart.quiesce().catch(() => markBlocked(current));
      return { kind: "cancelled", state };
    }
    connectionStart.adopt();
    current.connection = connectionResult.value;
    if (!sharedContinuationAllowed(current))
      return { kind: "cancelled", state };
    const beforeCapture = await checkAdmission();
    refreshProjection();
    const captureDiagnostic = admissionDiagnostic(beforeCapture);
    if (!currentAttempt(current)) return { kind: "cancelled", state };
    if (captureDiagnostic) {
      void beginStop(current, captureDiagnostic);
      return { kind: "cancelled", state };
    }
    try {
      if (!current.owner) throw new Error("missing owner");
      await validateOwner(current.owner);
      refreshProjection();
    } catch {
      void beginStop(current, "cleanup-blocked");
      markBlocked(current);
      return { kind: "cancelled", state: "blocked" };
    }
    if (!currentAttempt(current) || state !== "connecting")
      return { kind: "cancelled", state };
    const captureResult = await beginCapture(current, current.connectDeadline);
    if (captureResult.kind !== "value" || !currentAttempt(current))
      return { kind: "cancelled", state };
    state = "active";
    lastFailure = undefined;
    clearAttemptTimer(current, current.connectTimer);
    current.connectTimer = undefined;
    return { kind: "started", state: "active" };
  }

  async function stop(): Promise<LiveStopResult> {
    refreshProjection();
    if (state === "blocked") return { status: "blocked" };
    if (state === "releasing") {
      if (attempt?.stopObservation) return attempt.stopObservation.promise;
      return { status: "release-pending" };
    }
    if (state === "off" || !attempt) return { status: "off" };
    return beginStop(attempt);
  }

  const lifecycle: LiveLifecycle = {
    snapshot,
    createOutgoingSender,
    start,
    async toggle(): Promise<LiveStartResult | LiveStopResult> {
      refreshProjection();
      if (state === "off") return start();
      if (
        state === "consent" ||
        state === "acquiring" ||
        state === "connecting" ||
        state === "active"
      )
        return stop();
      return {
        kind: "refused",
        state,
        diagnostic: state === "blocked" ? "cleanup-blocked" : "busy",
      };
    },
    stop,
    setMuted,
    async selectVoice(nextVoice: string): Promise<LiveMutationResult> {
      refreshProjection();
      if (state !== "off")
        return { kind: "refused", state, diagnostic: "busy" };
      if (!isLiveVoice(nextVoice))
        return { kind: "refused", state, diagnostic: "denied" };
      voice = nextVoice;
      return { kind: "updated", state, voice };
    },
    async interrupt(reason: LiveInterruptionReason): Promise<LiveStopResult> {
      refreshProjection();
      if (reason === "pooling" && coordination)
        coordination.poolingRefused = true;
      if (state === "off") {
        if (reason === "pooling") lastFailure = "denied";
        return { status: "off" };
      }
      if (state === "releasing") return stop();
      if (state === "blocked") return { status: "blocked" };
      if (!attempt) return { status: "off" };
      return beginStop(
        attempt,
        reason === "failure"
          ? "protocol-error"
          : reason === "observed-conflict"
            ? "busy"
            : undefined,
      );
    },
    delegationAdmitted(): LiveDelegationAdmissionResult {
      refreshProjection();
      const current = attempt;
      if (!current || state !== "active" || current.delegation)
        return { kind: "refused", state, diagnostic: "busy" };
      const token = {};
      const deadline = clock.now() + DELEGATION_MS;
      const observeDelegationDeadline = () => {
        const delegation = current.delegation;
        if (attempt !== current || !delegation || delegation.token !== token)
          return;
        if (clock.now() < deadline) {
          delegation.timer = schedule(
            current,
            deadline - clock.now(),
            observeDelegationDeadline,
          );
          return;
        }
        current.delegation = undefined;
        void beginStop(current);
      };
      const delegation: NonNullable<CallAttempt["delegation"]> = {
        token,
        deadline,
      };
      current.delegation = delegation;
      const timer = schedule(current, DELEGATION_MS, observeDelegationDeadline);
      if (
        attempt === current &&
        state === "active" &&
        current.delegation === delegation
      )
        delegation.timer = timer;
      else clearAttemptTimer(current, timer);
      return {
        kind: "updated",
        state: "active",
        settle(): void {
          if (attempt !== current) return;
          const delegation = current.delegation;
          if (!delegation || delegation.token !== token) return;
          clearAttemptTimer(current, delegation.timer);
          current.delegation = undefined;
          if (clock.now() >= delegation.deadline) void beginStop(current);
        },
      };
    },
  };
  return lifecycle;
}

const WIDGET_KEY = "pi-live";
const DELEGATION_MESSAGE_TYPE = "better-openai-live-delegation";

function clearPresentation(ctx: ExtensionContext): void {
  if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_KEY, undefined);
}

function compatibilityText(result: CompatibilityResult): string {
  return result.supported
    ? "supported"
    : `unsupported (${result.issues.join(", ")})`;
}

function setupWidget(
  voice: string,
  compatibility: CompatibilityResult,
): string[] {
  return [
    "Pi Live: off (setup-only)",
    `Voice: ${voice}`,
    `Compatibility: ${compatibilityText(compatibility)}`,
  ];
}

function delegationText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (item): item is { type: "text"; text: string } =>
        typeof item === "object" &&
        item !== null &&
        "type" in item &&
        item.type === "text" &&
        "text" in item &&
        typeof item.text === "string",
    )
    .map((item) => item.text)
    .join("\n");
}

export type TruncateToWidth = (
  value: string,
  width: number,
  ellipsis?: string,
) => string;

function fitLine(
  text: string,
  width: number,
  truncateToWidth: TruncateToWidth,
): string {
  if (width <= 0) return "";
  return truncateToWidth(
    text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " "),
    width,
    "",
  );
}

export interface LiveDependencies {
  preferences: PreferenceStore;
  compatibility: CompatibilityChecker;
  truncateToWidth: TruncateToWidth;
}

export function createLiveDependencies(
  truncateToWidth: TruncateToWidth,
): LiveDependencies {
  return {
    preferences: createFilePreferenceStore(),
    compatibility: createCompatibilityChecker(),
    truncateToWidth,
  };
}

export function registerPiLive(
  pi: ExtensionAPI,
  dependencies: LiveDependencies,
): void {
  const handleTui = async (
    command: string,
    ctx: ExtensionContext,
  ): Promise<void> => {
    if (command === "status") {
      const preferences = await dependencies.preferences.load();
      const compatibility = await dependencies.compatibility.check();
      const compatibilitySummary = compatibility.supported
        ? "compatibility ready"
        : `compatibility unavailable (${compatibility.issues.join(", ")})`;
      ctx.ui.notify(
        `Pi Live: off; voice ${preferences.voice}; ${compatibilitySummary}; calling unavailable (setup-only).`,
        "info",
      );
      return;
    }
    if (command === "help") {
      ctx.ui.notify(
        "Pi Live is setup-only: calling is unavailable. Future reviewed calling uses this host microphone and speaker with an OpenAI experimental protocol, shares the Pi session identifier and final coding result, and handles one coding request at a time. Pi cannot report shortcut-opened dialogs; stop voice first before opening one when capture and delivery must stop. Controls: /live, start, stop, mute, unmute, voice <name>, status, help; shortcut Ctrl+Shift+L.",
        "info",
      );
      return;
    }
    if (command === "voice") {
      ctx.ui.notify(
        "Usage: /live [start|stop|mute|unmute|voice <name>|status|help]",
        "error",
      );
      return;
    }
    if (command.startsWith("voice ")) {
      const selected = command.slice("voice ".length).trim();
      if (!isLiveVoice(selected)) {
        ctx.ui.notify(
          `Unknown Pi Live voice. Available: ${LIVE_VOICE_VALUES.join(", ")}.`,
          "error",
        );
        return;
      }
      await dependencies.preferences.setVoice(selected);
      ctx.ui.notify(
        `Pi Live voice set to ${selected} for the next call.`,
        "info",
      );
      return;
    }
    if (command === "stop") {
      clearPresentation(ctx);
      ctx.ui.notify("Pi Live is off.", "info");
      return;
    }
    if (command === "mute" || command === "unmute") {
      ctx.ui.notify(`Pi Live is off; ${command} is unavailable.`, "warning");
      return;
    }
    if (command === "" || command === "start") {
      const preferences = await dependencies.preferences.load();
      const compatibility = await dependencies.compatibility.check();
      ctx.ui.setWidget(
        WIDGET_KEY,
        setupWidget(preferences.voice, compatibility),
      );
      ctx.ui.notify(
        "Pi Live calling is unavailable in this setup-only package.",
        "warning",
      );
      return;
    }
    ctx.ui.notify(
      "Usage: /live [start|stop|mute|unmute|voice <name>|status|help]",
      "error",
    );
  };

  const handle = async (args: string, ctx: ExtensionContext): Promise<void> => {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("Pi Live requires interactive TUI mode.", "warning");
      return;
    }
    try {
      await handleTui(args.trim(), ctx);
    } catch (error) {
      if (error instanceof PreferenceError) {
        const description =
          error.code === "malformed"
            ? "is malformed"
            : error.code === "invalid-voice"
              ? "selects an invalid voice"
              : "could not be accessed or written";
        ctx.ui.notify(`Pi Live preference ${description}.`, "error");
        return;
      }
      ctx.ui.notify("Pi Live preference could not be accessed.", "error");
    }
  };

  pi.registerMessageRenderer(DELEGATION_MESSAGE_TYPE, (message) => {
    const text = delegationText(message.content).trim();
    return {
      render: (width: number) => [
        fitLine("Live request", width, dependencies.truncateToWidth),
        ...text
          .split("\n")
          .map((line) => fitLine(line, width, dependencies.truncateToWidth)),
      ],
      invalidate: () => undefined,
    };
  });
  pi.registerCommand("live", {
    description: "Control the setup-only Pi Live voice package",
    handler: handle,
  });
  pi.registerShortcut("ctrl+shift+l", {
    description: "Toggle Pi Live voice",
    handler: (ctx) => handle("", ctx),
  });
  pi.on("session_shutdown", (_event, ctx) => clearPresentation(ctx));
}
// --- Dormant Pi lifecycle/conflict binding (issue #3) ---

export const PINNED_BETTER_OPENAI_PACKAGE_SOURCES = [
  "npm:@monotykamary/pi-better-openai@0.2.6",
  "git:github.com/monotykamary/pi-better-openai@39171682343754366439b2c0890f5b0f4c3ed891",
] as const;

const PINNED_BETTER_OPENAI_LIVE_DESCRIPTION =
  "Start or stop Codex-backed realtime voice mode";
const MULTIPROVIDER_SERVICE_EVENT = "pi-multiprovider:service";

export interface LivePiAdmissionFacts {
  compatible: boolean;
  conflict?: boolean;
  dialog?: boolean;
  /** Host-observed package declarations; this is not a complete package inventory. */
  configuredPackageSources?: readonly string[];
}

export interface LivePiConsentInput {
  generation: string;
  voice: string;
  signal: AbortSignal;
  openConfirm(title: string, message: string): Promise<boolean>;
}

export interface LiveLifecycleBindingOptions {
  lifecycle?: Omit<LiveLifecycleOptions, "admission" | "consent">;
  facts: {
    check(
      ctx: ExtensionContext,
    ): LivePiAdmissionFacts | Promise<LivePiAdmissionFacts>;
  };
  consent: {
    request(input: LivePiConsentInput): Promise<boolean>;
  };
}

export interface LiveLifecycleBinding {
  lifecycle: LiveLifecycle;
}

function isSourceInfoObservation(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const sourceInfo = value as Record<string, unknown>;
  return (
    typeof sourceInfo.path === "string" &&
    typeof sourceInfo.source === "string" &&
    (sourceInfo.scope === "user" ||
      sourceInfo.scope === "project" ||
      sourceInfo.scope === "temporary") &&
    (sourceInfo.origin === "package" || sourceInfo.origin === "top-level") &&
    (sourceInfo.baseDir === undefined || typeof sourceInfo.baseDir === "string")
  );
}

function isCommandObservation(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const command = value as Record<string, unknown>;
  return (
    typeof command.name === "string" &&
    (command.description === undefined ||
      typeof command.description === "string") &&
    (command.source === "extension" ||
      command.source === "prompt" ||
      command.source === "skill") &&
    isSourceInfoObservation(command.sourceInfo)
  );
}

function isPinnedBetterOpenAILiveCommand(value: unknown): boolean {
  if (!isCommandObservation(value)) return false;
  const command = value as Record<string, unknown>;
  if (
    command.source !== "extension" ||
    command.description !== PINNED_BETTER_OPENAI_LIVE_DESCRIPTION ||
    (command.name !== "live" &&
      !(
        typeof command.name === "string" &&
        /^live:[1-9][0-9]*$/.test(command.name)
      ))
  )
    return false;
  const provenance = command.sourceInfo as Record<string, unknown>;
  return (
    provenance.origin === "package" &&
    (provenance.scope === "user" || provenance.scope === "project") &&
    PINNED_BETTER_OPENAI_PACKAGE_SOURCES.some(
      (source) => provenance.source === source,
    )
  );
}

function hasPinnedBetterOpenAIConflict(pi: ExtensionAPI): boolean {
  try {
    const commands: unknown = pi.getCommands();
    if (!Array.isArray(commands) || !commands.every(isCommandObservation))
      return true;
    return commands.some(isPinnedBetterOpenAILiveCommand);
  } catch {
    return true;
  }
}

function hasConfiguredBetterOpenAIConflict(value: unknown): boolean {
  if (value === undefined) return false;
  if (
    !Array.isArray(value) ||
    !value.every((source) => typeof source === "string")
  )
    return true;
  return value.some((source) =>
    PINNED_BETTER_OPENAI_PACKAGE_SOURCES.some((pinned) => source === pinned),
  );
}

function isMultiproviderServiceAnnouncement(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const service = value as Record<string, unknown>;
  return (
    typeof service.getActiveAccount === "function" &&
    typeof service.resolveActiveAccountAuth === "function" &&
    typeof service.onActiveAccountChanged === "function"
  );
}

/*
 * Pi reports only the outermost blocking prompt. An unreported nested dialog
 * cannot trigger immediate cancellation. If it remains open when own consent
 * returns, the missing outer prompt end keeps startup admission closed. Issue
 * #5 owns the actual consent UI.
 */
export function bindPiLiveLifecycle(
  pi: ExtensionAPI,
  options: LiveLifecycleBindingOptions,
): LiveLifecycleBinding {
  interface ConsentInvocation {
    generation: string;
    signal: AbortSignal;
    openConfirmUsed: boolean;
    promptAmbiguous: boolean;
  }
  interface ConsentPromptToken {
    consent: ConsentInvocation;
    generation: string;
    signal: AbortSignal;
    phase: "pending" | "armed" | "consumed" | "expired";
  }

  let currentContext: ExtensionContext | undefined;
  let activeConsent: ConsentInvocation | undefined;
  let consentPromptToken: ConsentPromptToken | undefined;
  let observedCommandConflict = false;
  let reportedPromptOpen: { owner: "live" | "external" } | undefined;
  let retired = false;

  const lifecycle = createLiveLifecycle({
    ...(options.lifecycle ?? {}),
    admission: {
      async check(): Promise<LiveAdmissionFacts> {
        const ctx = currentContext;
        if (!ctx || retired) return DEFAULT_ADMISSION;
        observedCommandConflict ||= hasPinnedBetterOpenAIConflict(pi);
        const facts = await options.facts.check(ctx);
        observedCommandConflict ||= hasConfiguredBetterOpenAIConflict(
          facts.configuredPackageSources,
        );
        return {
          tui: ctx.mode === "tui",
          compatible: facts.compatible,
          conflict: observedCommandConflict || facts.conflict === true,
          dialog: reportedPromptOpen !== undefined || facts.dialog === true,
          idle: ctx.isIdle(),
          pendingWork: ctx.hasPendingMessages() || ctx.signal !== undefined,
        };
      },
    },
    consent: {
      async request(input): Promise<boolean> {
        const ctx = currentContext;
        if (!ctx || retired || input.signal.aborted) return false;
        const consent: ConsentInvocation = {
          generation: input.generation,
          signal: input.signal,
          openConfirmUsed: false,
          promptAmbiguous: false,
        };
        activeConsent = consent;

        const tokenIsCurrent = (token: ConsentPromptToken): boolean =>
          consentPromptToken === token &&
          activeConsent === consent &&
          token.consent === consent &&
          token.generation === input.generation &&
          token.signal === input.signal &&
          !token.signal.aborted &&
          !retired;

        const openConfirm = (
          title: string,
          message: string,
        ): Promise<boolean> => {
          if (
            consent.openConfirmUsed ||
            activeConsent !== consent ||
            consent.generation !== input.generation ||
            consent.signal !== input.signal ||
            input.signal.aborted ||
            retired
          ) {
            consent.promptAmbiguous = true;
            return Promise.resolve(false);
          }
          consent.openConfirmUsed = true;
          const token: ConsentPromptToken = {
            consent,
            generation: input.generation,
            signal: input.signal,
            phase: "pending",
          };
          consentPromptToken = token;
          queueMicrotask(() => {
            if (!tokenIsCurrent(token)) {
              if (consentPromptToken === token) consentPromptToken = undefined;
              consent.promptAmbiguous = true;
              return;
            }
            token.phase = "armed";
            queueMicrotask(() => {
              if (!tokenIsCurrent(token) || token.phase !== "armed") return;
              token.phase = "expired";
              consentPromptToken = undefined;
              consent.promptAmbiguous = true;
            });
          });

          try {
            return ctx.ui.confirm(title, message, { signal: input.signal });
          } catch (error) {
            if (consentPromptToken === token) consentPromptToken = undefined;
            token.phase = "expired";
            consent.promptAmbiguous = true;
            return Promise.reject(error);
          }
        };

        try {
          const accepted = await options.consent.request({
            ...input,
            openConfirm,
          });
          if (
            activeConsent !== consent ||
            consent.generation !== input.generation ||
            consent.signal !== input.signal ||
            input.signal.aborted ||
            retired ||
            !consent.openConfirmUsed ||
            consent.promptAmbiguous
          )
            return false;
          return accepted;
        } finally {
          if (activeConsent === consent) activeConsent = undefined;
          if (consentPromptToken?.consent === consent)
            consentPromptToken = undefined;
        }
      },
    },
  });

  const enter = (ctx: ExtensionContext): void => {
    currentContext = ctx;
  };
  const interrupt = (
    reason: LiveInterruptionReason,
  ): Promise<LiveStopResult> => {
    const pending = lifecycle.interrupt(reason);
    void pending.catch(() => undefined);
    return pending;
  };
  const interruptBeforeMovement = async (
    ctx: ExtensionContext,
  ): Promise<{ cancel: true } | undefined> => {
    enter(ctx);
    const result = await interrupt("lifecycle-change");
    return result.status === "off" ? undefined : { cancel: true };
  };

  pi.on("session_start", async (_event, ctx) => {
    enter(ctx);
    observedCommandConflict ||= hasPinnedBetterOpenAIConflict(pi);
    if (observedCommandConflict) await interrupt("observed-conflict");
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    retired = true;
    if (activeConsent) activeConsent.promptAmbiguous = true;
    consentPromptToken = undefined;
    enter(ctx);
    await interrupt("lifecycle-change");
  });
  pi.on("session_before_tree", (_event, ctx) => interruptBeforeMovement(ctx));
  pi.on("session_before_switch", (_event, ctx) => interruptBeforeMovement(ctx));
  pi.on("session_before_fork", (_event, ctx) => interruptBeforeMovement(ctx));
  pi.on("ui_prompt_start", (event, ctx) => {
    enter(ctx);
    const token = consentPromptToken;
    const ownPrompt =
      reportedPromptOpen === undefined &&
      token !== undefined &&
      token.phase === "armed" &&
      event.kind === "confirm" &&
      activeConsent === token.consent &&
      token.generation === token.consent.generation &&
      token.signal === token.consent.signal &&
      !token.signal.aborted &&
      !retired;

    if (ownPrompt && token) {
      token.phase = "consumed";
      consentPromptToken = undefined;
      reportedPromptOpen = { owner: "live" };
      return;
    }

    if (token) {
      token.phase = "expired";
      token.consent.promptAmbiguous = true;
      if (consentPromptToken === token) consentPromptToken = undefined;
    }
    if (reportedPromptOpen === undefined)
      reportedPromptOpen = { owner: "external" };
    else reportedPromptOpen.owner = "external";
    void interrupt("reported-dialog");
  });
  pi.on("ui_prompt_end", (_event, ctx) => {
    enter(ctx);
    reportedPromptOpen = undefined;
  });
  pi.events.on(MULTIPROVIDER_SERVICE_EVENT, (announcement) => {
    if (!isMultiproviderServiceAnnouncement(announcement)) return;
    void interrupt("pooling").catch(() => undefined);
  });

  return { lifecycle };
}
