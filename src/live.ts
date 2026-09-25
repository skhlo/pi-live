import { createHash, randomUUID } from "node:crypto";
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
import { createRequire } from "node:module";
import { hostname, userInfo } from "node:os";
import path from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
  MessageEndEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Dispatcher } from "undici";

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

const LIVE_LIMITS = {
  accessTokenBytes: 16 * 1_024,
  accountIdBytes: 256,
  credentialEnvelopeBytes: 20 * 1_024,
  deviceCheckTokenBytes: 8 * 1_024,
  attestationHeaderBytes: 16 * 1_024,
  combinedHeaderBytes: 64 * 1_024,
  sdpBytes: 1_024 * 1_024,
  signalingRequestBytes: 2 * 1_024 * 1_024,
  nonOkBodyBytes: 8 * 1_024,
  inboundBytes: 256 * 1_024,
  idBytes: 256,
  contextChunkBytes: 500,
  textBytes: 64 * 1_024,
  contentEntries: 64,
  seenIds: 256,
  pendingProducers: 256,
  retainedProducerBytes: 256 * 1_024,
  pendingFragments: 256,
  pendingEnvelopeBytes: 256 * 1_024,
  socketHighWaterBytes: 256 * 1_024,
  microphoneSamples: 16_000,
  microphoneBucket: 32_000,
  microphoneRefillPerSecond: 16_000,
  eventBucket: 200,
  eventRefillPerSecond: 200,
} as const;

export interface LiveCredentials {
  accessToken: string;
  accountId: string;
}

export interface LiveCredentialRegistry {
  getApiKeyForProvider(provider: string): Promise<string | undefined>;
}

export interface LiveCredentialResolutionOptions {
  signal?: AbortSignal;
  now?: () => number;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidUtf8String(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function validCredentialField(
  value: unknown,
  maxBytes: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    isValidUtf8String(value) &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    Buffer.byteLength(value, "utf8") <= maxBytes
  );
}

interface ParsedLiveJwt {
  accountId: string;
}

function parseLiveJwt(token: string, now: number): ParsedLiveJwt | undefined {
  try {
    if (!isValidUtf8String(token)) return undefined;
    const parts = token.split(".");
    const payloadPart = parts[1];
    if (
      parts.length !== 3 ||
      !parts[0] ||
      !payloadPart ||
      !parts[2] ||
      !/^[A-Za-z0-9_-]+$/.test(payloadPart)
    )
      return undefined;
    const decoded = Buffer.from(payloadPart, "base64url");
    if (
      decoded.byteLength > LIVE_LIMITS.accessTokenBytes ||
      decoded.toString("base64url") !== payloadPart
    )
      return undefined;
    const text = decodeUtf8(decoded);
    if (text === undefined) return undefined;
    const parsed = JSON.parse(text) as unknown;
    if (!isUnknownRecord(parsed)) return undefined;
    const expiry = parsed.exp;
    if (
      typeof expiry !== "number" ||
      !Number.isFinite(expiry) ||
      expiry <= now / 1_000
    )
      return undefined;
    const auth = parsed["https://api.openai.com/auth"];
    if (!isUnknownRecord(auth)) return undefined;
    const accountId = auth.chatgpt_account_id;
    if (!validCredentialField(accountId, LIVE_LIMITS.accountIdBytes))
      return undefined;
    return { accountId };
  } catch {
    return undefined;
  }
}

function parseLiveRegistryCredentials(
  raw: string | undefined,
  now: number,
): LiveCredentials | undefined {
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    Buffer.byteLength(raw, "utf8") > LIVE_LIMITS.credentialEnvelopeBytes
  )
    return undefined;
  const value = raw.trim();
  if (!value) return undefined;

  try {
    const parsed = JSON.parse(value) as unknown;
    if (isUnknownRecord(parsed)) {
      const accessToken =
        typeof parsed.access === "string"
          ? parsed.access
          : typeof parsed.token === "string"
            ? parsed.token
            : undefined;
      const accountId =
        typeof parsed.accountId === "string"
          ? parsed.accountId
          : typeof parsed.account_id === "string"
            ? parsed.account_id
            : undefined;
      const expiry = parsed.expires;
      if (
        !validCredentialField(accessToken, LIVE_LIMITS.accessTokenBytes) ||
        !validCredentialField(accountId, LIVE_LIMITS.accountIdBytes)
      )
        return undefined;
      const tokenLooksLikeJwt = accessToken.split(".").length === 3;
      if (tokenLooksLikeJwt) {
        const jwt = parseLiveJwt(accessToken, now);
        if (!jwt || jwt.accountId !== accountId) return undefined;
        if (
          expiry !== undefined &&
          (typeof expiry !== "number" ||
            !Number.isFinite(expiry) ||
            expiry <= now)
        )
          return undefined;
        return { accessToken, accountId };
      }
      if (
        typeof expiry !== "number" ||
        !Number.isFinite(expiry) ||
        expiry <= now
      )
        return undefined;
      return { accessToken, accountId };
    }
  } catch {
    // Pi normally returns the plain OAuth access token.
  }

  if (!validCredentialField(value, LIVE_LIMITS.accessTokenBytes))
    return undefined;
  const jwt = parseLiveJwt(value, now);
  return jwt ? { accessToken: value, accountId: jwt.accountId } : undefined;
}

export async function resolveLiveRegistryCredentials(
  registry: LiveCredentialRegistry,
  options: LiveCredentialResolutionOptions = {},
): Promise<LiveCredentials | undefined> {
  if (options.signal?.aborted) return undefined;
  let request: Promise<string | undefined>;
  try {
    request = registry.getApiKeyForProvider("openai-codex");
  } catch {
    return undefined;
  }

  const observed = request.then(
    (value) => ({ kind: "value" as const, value }),
    () => ({ kind: "error" as const }),
  );
  let removeAbort: (() => void) | undefined;
  const cancelled = options.signal
    ? new Promise<{ kind: "cancelled" }>((resolve) => {
        const onAbort = () => resolve({ kind: "cancelled" });
        options.signal!.addEventListener("abort", onAbort, { once: true });
        removeAbort = () =>
          options.signal!.removeEventListener("abort", onAbort);
        if (options.signal!.aborted) onAbort();
      })
    : undefined;
  const result = cancelled
    ? await Promise.race([observed, cancelled])
    : await observed;
  removeAbort?.();
  if (result.kind !== "value" || options.signal?.aborted) return undefined;
  return parseLiveRegistryCredentials(
    result.value,
    (options.now ?? Date.now)(),
  );
}

export interface LiveDeviceCheckResult {
  supported: boolean;
  tokenBase64?: string;
  error?: string;
  latencyMs: number;
}

export interface LiveDeviceCheck {
  generateToken(): Promise<LiveDeviceCheckResult>;
}

export interface LiveAttestation {
  header: string;
  supported: boolean;
}

export interface LiveAttestationOptions {
  locale?: string;
  timeZone?: string;
  appSessionId?: string;
}

function cborHeader(major: number, value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("Live attestation data is invalid.");
  if (value < 24) return Buffer.from([major + value]);
  if (value <= 0xff) return Buffer.from([major + 24, value]);
  if (value <= 0xffff) {
    const output = Buffer.allocUnsafe(3);
    output[0] = major + 25;
    output.writeUInt16BE(value, 1);
    return output;
  }
  if (value <= 0xffff_ffff) {
    const output = Buffer.allocUnsafe(5);
    output[0] = major + 26;
    output.writeUInt32BE(value, 1);
    return output;
  }
  throw new Error("Live attestation data is invalid.");
}

function cborUnsigned(value: number): Buffer {
  return cborHeader(0, value);
}

function cborText(value: string): Buffer {
  if (!isValidUtf8String(value))
    throw new Error("Live attestation data is invalid.");
  const text = Buffer.from(value, "utf8");
  return Buffer.concat([cborHeader(96, text.byteLength), text]);
}

function cborMap(entries: ReadonlyArray<readonly [Buffer, Buffer]>): Buffer {
  const parts: Buffer[] = [cborHeader(160, entries.length)];
  for (const [key, value] of entries) parts.push(key, value);
  return Buffer.concat(parts);
}

function liveAttestationSignals(options: LiveAttestationOptions): Buffer {
  const resolved = Intl.DateTimeFormat().resolvedOptions();
  const locale = (options.locale ?? resolved.locale ?? "unknown").slice(0, 64);
  const timeZone = (options.timeZone ?? resolved.timeZone ?? "unknown").slice(
    0,
    64,
  );
  const appSessionId = (options.appSessionId ?? randomUUID()).slice(0, 128);
  const preferredLanguages = Buffer.concat([
    cborHeader(128, 1),
    cborText(locale),
  ]);
  return cborMap([
    [cborUnsigned(0), cborUnsigned(1)],
    [cborUnsigned(1), preferredLanguages],
    [cborUnsigned(2), cborText(locale)],
    [cborUnsigned(3), cborText(timeZone)],
    [cborUnsigned(4), cborUnsigned(0)],
    [cborUnsigned(5), cborUnsigned(1)],
    [cborUnsigned(6), cborText(appSessionId)],
  ]);
}

function decodeDeviceCheckToken(value: string): Buffer | undefined {
  const maximumEncodedLength =
    Math.ceil(LIVE_LIMITS.deviceCheckTokenBytes / 3) * 4;
  if (
    value.length === 0 ||
    value.length > maximumEncodedLength ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    return undefined;
  const decoded = Buffer.from(value, "base64");
  return decoded.byteLength <= LIVE_LIMITS.deviceCheckTokenBytes &&
    decoded.toString("base64") === value
    ? decoded
    : undefined;
}

function buildLiveClientAttestation(
  result: LiveDeviceCheckResult,
  options: LiveAttestationOptions,
): string {
  const entries: Array<readonly [Buffer, Buffer]> = [];
  if (result.supported) {
    if (
      result.error !== undefined ||
      typeof result.tokenBase64 !== "string" ||
      !decodeDeviceCheckToken(result.tokenBase64)
    )
      throw new Error("Live attestation data is invalid.");
    entries.push([cborText("token"), cborText(result.tokenBase64)]);
  } else {
    if (result.error !== undefined || result.tokenBase64 !== undefined)
      throw new Error("Live attestation data is invalid.");
    entries.push([cborText("error_code"), cborUnsigned(3)]);
  }
  entries.push([cborText("bundle_id"), cborText("com.openai.codex")]);
  const signals = liveAttestationSignals(options);
  entries.push([
    cborText("f"),
    Buffer.concat([cborHeader(64, signals.byteLength), signals]),
  ]);
  if (Number.isFinite(result.latencyMs)) {
    const latency = Buffer.allocUnsafe(9);
    latency[0] = 0xfb;
    latency.writeDoubleBE(result.latencyMs, 1);
    entries.push([cborText("t"), latency]);
  }
  return `v1.${cborMap(entries).toString("base64url")}`;
}

export async function prepareLiveAttestation(
  deviceCheck: LiveDeviceCheck,
  options: LiveAttestationOptions = {},
): Promise<LiveAttestation> {
  let result: LiveDeviceCheckResult;
  try {
    result = await deviceCheck.generateToken();
  } catch {
    throw new Error("Live attestation failed.");
  }
  if (
    typeof result?.supported !== "boolean" ||
    typeof result.latencyMs !== "number" ||
    !Number.isFinite(result.latencyMs) ||
    result.latencyMs < 0 ||
    (result.tokenBase64 !== undefined &&
      typeof result.tokenBase64 !== "string") ||
    (result.error !== undefined && typeof result.error !== "string")
  )
    throw new Error("Live attestation data is invalid.");
  const clientAttestation = buildLiveClientAttestation(result, options);
  const header = JSON.stringify({ v: 1, s: 0, t: clientAttestation });
  if (Buffer.byteLength(header, "utf8") > LIVE_LIMITS.attestationHeaderBytes)
    throw new Error("Live attestation data is invalid.");
  return { header, supported: result.supported };
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
    onSample: (samples: Float32Array) => void,
  ): LiveResourceStart<LiveCapture>;
  sendSample(samples: Float32Array): void | Promise<void>;
  sendData?(data: LiveOutgoingData): void | Promise<void>;
  closeSession(request: LiveSessionCloseRequest): void | Promise<void>;
  close(): Promise<void>;
}

export interface LiveResources {
  credentials(input: { signal: AbortSignal }): Promise<LiveCredentials>;
  attestation(input: {
    signal: AbortSignal;
    credentials: LiveCredentials;
  }): Promise<LiveAttestation>;
  connect(input: {
    signal: AbortSignal;
    deadline: number;
    credentials: LiveCredentials;
    attestation: LiveAttestation;
    voice: string;
    onFailure?(diagnostic: LiveDiagnostic): void;
  }): LiveResourceStart<LiveConnection>;
}

export interface LiveHttpResponse {
  status: number;
  statusText: string;
  location?: string;
  body: AsyncIterable<Uint8Array>;
  cancel(): void | Promise<void>;
}

export interface LiveSignalingStartInput {
  url: string;
  method: "POST";
  redirect: "manual";
  headers: Record<string, string>;
  body: string;
  proxyUrl?: string;
  signal: AbortSignal;
}

export interface LiveSidebandSocket {
  bufferedAmount(): number;
  sendText(payload: string): Promise<void>;
  sendPong(payload: Uint8Array): Promise<void>;
  close(): Promise<boolean>;
}

export interface LiveSidebandStartInput {
  url: string;
  headers: Record<string, string>;
  followRedirects: false;
  maxPayloadBytes: number;
  autoPong: false;
  proxyUrl?: string;
  signal: AbortSignal;
  onText(payload: Uint8Array): void;
  onBinary(payload: Uint8Array): void;
  onPing(payload: Uint8Array): void;
  onPong(payload: Uint8Array): void;
  onFailure(failure: LiveSidebandFailure): void;
  onClose(): void;
}

export type LiveSidebandFailure =
  | { kind: "transient" }
  | { kind: "http"; status: number }
  | { kind: "malformed" }
  | { kind: "cancelled" };

export interface LiveNetworkAdapter {
  signal(input: LiveSignalingStartInput): LiveResourceStart<LiveHttpResponse>;
  openSideband(
    input: LiveSidebandStartInput,
  ): LiveResourceStart<LiveSidebandSocket>;
}

export interface LiveNativePeer {
  createOffer(): Promise<string>;
  acceptAnswer(sdp: string): Promise<void>;
  waitForOpen(): Promise<void>;
  pushAudio(samples: Float32Array): void;
  setMuted(muted: boolean): void;
  close(): Promise<boolean>;
}

export interface LiveNativeAdapter {
  deviceCheck: LiveDeviceCheck;
  createPeer(input: {
    onEvent(payload: string): void;
    onOutputLevel(level: number): void;
    onFailure(): void;
  }): LiveResourceStart<LiveNativePeer>;
  startCapture(input: {
    onSample(samples: Float32Array): void;
    onFailure(): void;
  }): LiveResourceStart<LiveCapture>;
}

export interface LiveRuntimeDiagnostic {
  code: LiveDiagnostic;
  phase:
    | "credentials"
    | "attestation"
    | "offer"
    | "signaling"
    | "answer"
    | "native-open"
    | "sideband"
    | "audio"
    | "protocol"
    | "cleanup";
  text: string;
  httpStatus?: number;
  dependencyVersion?: string;
}

export interface LiveRuntimeResourcesOptions {
  registry: LiveCredentialRegistry;
  sessionId: string;
  instructions: string;
  native?: LiveNativeAdapter;
  network?: LiveNetworkAdapter;
  clock?: LiveClock;
  randomId?: () => string;
  proxyForUrl?: (
    url: string,
  ) => string | undefined | Promise<string | undefined>;
  callbacks?: {
    onLevel?(level: number): void;
    onRequest?(request: { id: string; text: string }): boolean;
    onTranscript?(transcript: {
      role: "user" | "assistant";
      text: string;
    }): void;
    onDiagnostic?(diagnostic: LiveRuntimeDiagnostic): void;
  };
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
  microphoneTokens: number;
  microphoneBucketAt: number;
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

const LIVE_SIGNALING_URL =
  "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas";
const LIVE_SIDEBAND_ORIGIN = "https://api.openai.com";
const LIVE_CLIENT_VERSION = "0.144.1";
const LIVE_MODEL = "gpt-live-1-codex";
const LIVE_SIDE_BAND_ATTEMPTS = 3;
const LIVE_PHASE_MS = 10_000;
const LIVE_SEND_MS = 5_000;
const LIVE_CONTROL_FRAME_BYTES = 125;
const LIVE_WEBSOCKET_FRAME_OVERHEAD = 14;
const LIVE_PENDING_ENVELOPE_MAX_BYTES = 4 * 1_024;

class LiveRuntimeError extends Error {
  readonly kind: "timeout" | "protocol" | "cancelled" | "cleanup";

  constructor(kind: LiveRuntimeError["kind"], message: string) {
    super(message);
    this.kind = kind;
  }
}

function fixedRuntimeError(kind: LiveRuntimeError["kind"]): LiveRuntimeError {
  switch (kind) {
    case "timeout":
      return new LiveRuntimeError(kind, "Live transport connection timed out.");
    case "cancelled":
      return new LiveRuntimeError(kind, "Live transport was cancelled.");
    case "cleanup":
      return new LiveRuntimeError(
        kind,
        "Live transport cleanup is unconfirmed.",
      );
    case "protocol":
      return new LiveRuntimeError(kind, "Live transport protocol failed.");
  }
}

function runtimeDiagnosticText(code: LiveDiagnostic): string {
  switch (code) {
    case "busy":
      return "Pi Live is busy.";
    case "missing-auth":
      return "Pi Live authentication is unavailable.";
    case "denied":
      return "Pi Live permission was denied.";
    case "connect-timeout":
      return "Pi Live connection timed out.";
    case "protocol-error":
      return "Pi Live protocol failed.";
    case "audio-error":
      return "Pi Live audio failed.";
    case "cleanup-blocked":
      return "Pi Live cleanup could not be confirmed.";
  }
}

function byteLengthWithin(value: string, maximum: number): boolean {
  return Buffer.byteLength(value, "utf8") <= maximum;
}

function validHeaderValue(value: string): boolean {
  return isValidUtf8String(value) && !/[\u0000-\u001f\u007f]/.test(value);
}

function combinedHeaderBytes(headers: Record<string, string>): number {
  let total = 0;
  for (const [name, value] of Object.entries(headers))
    total += Buffer.byteLength(`${name}: ${value}\r\n`, "utf8");
  return total;
}

function buildLiveHeaders(
  credentials: LiveCredentials,
  sessionId: string,
  realtimeSessionId: string,
  attestation: LiveAttestation,
): Record<string, string> {
  const accessToken = credentials.accessToken;
  const accountId = credentials.accountId;
  const attestationHeader = attestation.header;
  if (
    !validCredentialField(accessToken, LIVE_LIMITS.accessTokenBytes) ||
    !validCredentialField(accountId, LIVE_LIMITS.accountIdBytes) ||
    !validCredentialField(sessionId, LIVE_LIMITS.idBytes) ||
    !validCredentialField(realtimeSessionId, LIVE_LIMITS.idBytes) ||
    !validHeaderValue(attestationHeader) ||
    !byteLengthWithin(attestationHeader, LIVE_LIMITS.attestationHeaderBytes)
  )
    throw fixedRuntimeError("protocol");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "OpenAI-Alpha": "quicksilver=v2",
    "User-Agent": `Codex Desktop/${LIVE_CLIENT_VERSION}`,
    "x-session-id": realtimeSessionId,
    originator: "Codex Desktop",
    version: LIVE_CLIENT_VERSION,
    "session-id": sessionId,
    "thread-id": sessionId,
    "chatgpt-account-id": accountId,
    "x-oai-attestation": attestationHeader,
  };
  if (combinedHeaderBytes(headers) > LIVE_LIMITS.combinedHeaderBytes)
    throw fixedRuntimeError("protocol");
  return headers;
}

function parseLiveCallLocation(location: string | undefined): string {
  if (
    typeof location !== "string" ||
    location.length === 0 ||
    !byteLengthWithin(location, 2_048)
  )
    throw fixedRuntimeError("protocol");
  let parsed: URL;
  try {
    parsed = new URL(location, LIVE_SIDEBAND_ORIGIN);
  } catch {
    throw fixedRuntimeError("protocol");
  }
  if (
    parsed.origin !== LIVE_SIDEBAND_ORIGIN ||
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  )
    throw fixedRuntimeError("protocol");
  const canonicalAbsolute = `${LIVE_SIDEBAND_ORIGIN}${parsed.pathname}`;
  if (location !== parsed.pathname && location !== canonicalAbsolute)
    throw fixedRuntimeError("protocol");
  const match = /^\/v1\/live\/(rtc_[A-Za-z0-9_-]+)$/.exec(parsed.pathname);
  const callId = match?.[1];
  if (!callId || !byteLengthWithin(callId, LIVE_LIMITS.idBytes))
    throw fixedRuntimeError("protocol");
  return callId;
}

async function readBoundedBody(
  response: LiveHttpResponse,
  maximum: number,
  retain: boolean,
  deadline: number,
  clock: LiveClock,
  signal: AbortSignal,
): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  let total = 0;
  const stopRead = async (kind: "cancelled" | "timeout" | "protocol") => {
    try {
      await response.cancel();
    } catch {
      throw fixedRuntimeError("cleanup");
    }
    throw fixedRuntimeError(kind);
  };
  try {
    for await (const chunk of response.body) {
      if (signal.aborted) await stopRead("cancelled");
      if (clock.now() >= deadline) await stopRead("timeout");
      if (!(chunk instanceof Uint8Array)) await stopRead("protocol");
      if (total + chunk.byteLength > maximum) await stopRead("protocol");
      total += chunk.byteLength;
      if (retain && chunk.byteLength > 0) parts.push(chunk);
    }
    if (signal.aborted) await stopRead("cancelled");
    if (clock.now() >= deadline) await stopRead("timeout");
  } catch (error) {
    if (error instanceof LiveRuntimeError) throw error;
    throw fixedRuntimeError("protocol");
  }
  return retain ? Buffer.concat(parts, total) : Buffer.alloc(0);
}

function sidebandFailureIsTransient(failure: unknown): boolean {
  if (!isUnknownRecord(failure)) return false;
  if (failure.kind === "transient") return true;
  return (
    failure.kind === "http" &&
    typeof failure.status === "number" &&
    Number.isSafeInteger(failure.status) &&
    failure.status >= 500 &&
    failure.status <= 599
  );
}

function waitWithClock(
  clock: LiveClock,
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.reject(fixedRuntimeError("cancelled"));
  const deadline = clock.now() + Math.max(0, delayMs);
  return new Promise<void>((resolve, reject) => {
    let timer: LiveTimer;
    const onAbort = () => {
      clock.clearTimer(timer);
      signal.removeEventListener("abort", onAbort);
      reject(fixedRuntimeError("cancelled"));
    };
    const observeDeadline = () => {
      if (clock.now() < deadline) {
        timer = clock.setTimer(observeDeadline, deadline - clock.now());
        return;
      }
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    timer = clock.setTimer(observeDeadline, deadline - clock.now());
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

async function waitForRuntimePhase<T>(
  operation: Promise<T>,
  totalDeadline: number,
  clock: LiveClock,
  signal: AbortSignal,
): Promise<T> {
  const deadline = Math.min(totalDeadline, clock.now() + LIVE_PHASE_MS);
  if (signal.aborted) throw fixedRuntimeError("cancelled");
  if (clock.now() >= deadline) throw fixedRuntimeError("timeout");
  let timer: LiveTimer | undefined;
  let removeAbort: (() => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    const observeDeadline = () => {
      if (clock.now() < deadline) {
        timer = clock.setTimer(observeDeadline, deadline - clock.now());
        return;
      }
      reject(fixedRuntimeError("timeout"));
    };
    timer = clock.setTimer(observeDeadline, deadline - clock.now());
  });
  const cancelled = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(fixedRuntimeError("cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbort = () => signal.removeEventListener("abort", onAbort);
    if (signal.aborted) onAbort();
  });
  try {
    const value = await Promise.race([operation, timeout, cancelled]);
    if (clock.now() >= deadline) throw fixedRuntimeError("timeout");
    return value;
  } catch (error) {
    if (error instanceof LiveRuntimeError) throw error;
    if (
      isUnknownRecord(error) &&
      (error.kind === "transient" ||
        error.kind === "http" ||
        error.kind === "malformed" ||
        error.kind === "cancelled")
    )
      throw error;
    throw fixedRuntimeError("protocol");
  } finally {
    if (timer) clock.clearTimer(timer);
    removeAbort?.();
  }
}

function utf8Prefix(value: string, maximum: number): string {
  let bytes = 0;
  let index = 0;
  while (index < value.length) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) break;
    const characterBytes =
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
    if (bytes + characterBytes > maximum) break;
    bytes += characterBytes;
    index += codePoint > 0xffff ? 2 : 1;
  }
  return value.slice(0, index);
}

function utf8Tail(value: string, maximum: number): string {
  let bytes = 0;
  let index = value.length;
  while (index > 0) {
    let start = index - 1;
    const last = value.charCodeAt(start);
    if (last >= 0xdc00 && last <= 0xdfff && start > 0) {
      const first = value.charCodeAt(start - 1);
      if (first >= 0xd800 && first <= 0xdbff) start -= 1;
    }
    const codePoint = value.codePointAt(start);
    if (codePoint === undefined) break;
    const characterBytes =
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
    if (bytes + characterBytes > maximum) break;
    bytes += characterBytes;
    index = start;
  }
  return value.slice(index);
}

function truncateLiveFinal(value: string): string {
  if (byteLengthWithin(value, LIVE_LIMITS.textBytes)) return value;
  const marker = "\n[truncated]";
  return `${utf8Prefix(
    value,
    LIVE_LIMITS.textBytes - Buffer.byteLength(marker),
  )}${marker}`;
}

function liveTextChunkAt(
  value: string,
  start: number,
): { text: string; next: number } {
  if (value.length === 0) return { text: "", next: 0 };
  let bytes = 0;
  let index = start;
  while (index < value.length) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) break;
    const characterLength = codePoint > 0xffff ? 2 : 1;
    const characterBytes =
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
    if (bytes + characterBytes > LIVE_LIMITS.contextChunkBytes) break;
    bytes += characterBytes;
    index += characterLength;
  }
  return { text: value.slice(start, index), next: index };
}

function buildLiveSessionRequest(
  offer: string,
  instructions: string,
  voice: string,
): string {
  if (!byteLengthWithin(offer, LIVE_LIMITS.sdpBytes))
    throw fixedRuntimeError("protocol");
  if (
    !isValidUtf8String(instructions) ||
    !byteLengthWithin(instructions, LIVE_LIMITS.textBytes) ||
    !validCredentialField(voice, LIVE_LIMITS.idBytes)
  )
    throw fixedRuntimeError("protocol");
  const body = JSON.stringify({
    sdp: offer,
    session: {
      model: LIVE_MODEL,
      instructions,
      audio: { output: { voice } },
      delegation: { type: "client" },
    },
  });
  if (!byteLengthWithin(body, LIVE_LIMITS.signalingRequestBytes))
    throw fixedRuntimeError("protocol");
  return body;
}

function unsafeLiveDependencyDebug(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

function defaultProxyForUrl(url: string): Promise<string | undefined> {
  return Promise.resolve().then(() => {
    const proxyModule = liveRuntimeRequire("proxy-from-env") as {
      getProxyForUrl(target: string): string;
    };
    return proxyModule.getProxyForUrl(url) || undefined;
  });
}

export function createLiveRuntimeResources(
  options: LiveRuntimeResourcesOptions,
): LiveResources {
  const clock = options.clock ?? defaultClock();
  const native = options.native ?? createDefaultLiveNativeAdapter();
  const network = options.network ?? createDefaultLiveNetworkAdapter();
  const randomId = options.randomId ?? randomUUID;
  const proxyForUrl = options.proxyForUrl ?? defaultProxyForUrl;

  const report = (
    code: LiveDiagnostic,
    phase: LiveRuntimeDiagnostic["phase"],
    status?: number,
  ): void => {
    try {
      const safeStatus =
        status !== undefined &&
        Number.isSafeInteger(status) &&
        status >= 100 &&
        status <= 599
          ? status
          : undefined;
      options.callbacks?.onDiagnostic?.({
        code,
        phase,
        text: runtimeDiagnosticText(code),
        ...(safeStatus === undefined ? {} : { httpStatus: safeStatus }),
      });
    } catch {
      // Diagnostics cannot affect the call lifecycle.
    }
  };

  let debugRefusalReported = false;
  const refuseUnsafeDebug = (): void => {
    if (
      !unsafeLiveDependencyDebug(process.env.DEBUG) &&
      !unsafeLiveDependencyDebug(process.env.NODE_DEBUG)
    )
      return;
    if (!debugRefusalReported) {
      debugRefusalReported = true;
      report("denied", "protocol");
    }
    throw fixedRuntimeError("protocol");
  };

  return {
    async credentials({ signal }): Promise<LiveCredentials> {
      refuseUnsafeDebug();
      const resolved = await resolveLiveRegistryCredentials(options.registry, {
        signal,
      });
      if (resolved) return resolved;
      if (signal.aborted)
        throw new Error("Live authentication resolution was cancelled.");
      report("missing-auth", "credentials");
      throw new Error("Live authentication is unavailable.");
    },
    async attestation({ signal }): Promise<LiveAttestation> {
      refuseUnsafeDebug();
      if (signal.aborted) throw new Error("Live attestation was cancelled.");
      let prepared: LiveAttestation;
      try {
        prepared = await prepareLiveAttestation(native.deviceCheck);
      } catch {
        if (!signal.aborted) report("protocol-error", "attestation");
        throw new Error("Live attestation failed.");
      }
      if (signal.aborted) throw new Error("Live attestation was cancelled.");
      return prepared;
    },
    connect(input): LiveResourceStart<LiveConnection> {
      const closeController = new AbortController();
      const signal = AbortSignal.any([input.signal, closeController.signal]);
      const { credentials, attestation } = input;
      const pendingNative = new Set<Promise<unknown>>();
      const pendingNetworkReads = new Set<Promise<unknown>>();
      const pendingSocketSends = new Set<Promise<unknown>>();
      let peerStart: LiveResourceStart<LiveNativePeer> | undefined;
      let sidebandStart: LiveResourceStart<LiveSidebandSocket> | undefined;
      let peer: LiveNativePeer | undefined;
      let sideband: LiveSidebandSocket | undefined;
      let connection: LiveConnection | undefined;
      let active = true;
      let transportCleanupUnconfirmed = false;
      let closePromise: Promise<void> | undefined;

      const trackOperation = <T>(
        operations: Set<Promise<unknown>>,
        operation: Promise<T>,
      ): Promise<T> => {
        operations.add(operation);
        void operation.then(
          () => operations.delete(operation),
          () => operations.delete(operation),
        );
        return operation;
      };
      const trackNative = <T>(operation: Promise<T>): Promise<T> =>
        trackOperation(pendingNative, operation);
      const effectAllowed = (): boolean =>
        active && !input.signal.aborted && !closeController.signal.aborted;
      const requireEffectAllowed = (): void => {
        if (effectAllowed()) return;
        throw fixedRuntimeError(
          input.signal.aborted || closeController.signal.aborted
            ? "cancelled"
            : "protocol",
        );
      };
      const failActive = (
        code: LiveDiagnostic,
        phase: LiveRuntimeDiagnostic["phase"],
        status?: number,
      ) => {
        if (!active || input.signal.aborted || closeController.signal.aborted)
          return;
        active = false;
        closeController.abort();
        report(code, phase, status);
        try {
          input.onFailure?.(code);
        } catch {
          // The generation owner controls its own callback failure.
        }
      };

      let eventTokens: number = LIVE_LIMITS.eventBucket;
      let eventBucketAt = clock.now();
      const seenRequests = new Map<string, string>();
      const latestTranscripts = new Map<"user" | "assistant", string>();
      let activeDelegationId: string | undefined;
      let requestAdmissionPending = false;
      type WriterFragment = {
        kind: "text" | "pong";
        payload: string | Uint8Array;
        framedBytes: number;
        charged: boolean;
      };
      type WriterProducer = {
        kind: "text" | "pong";
        text?: string;
        pong?: Uint8Array;
        dataKind?: "application" | "final";
        delegationId?: string;
        offset: number;
        completed: boolean;
        fragment?: WriterFragment;
        retainedBytes: number;
        retained: boolean;
        deadline: number;
        final: boolean;
        settled: boolean;
        resolve(): void;
        reject(error: LiveRuntimeError): void;
      };
      const producerQueue: WriterProducer[] = [];
      let activeProducer: WriterProducer | undefined;
      let writerRunning = false;
      let writerStopped = false;
      let finalProducerPending = false;
      let pendingProducers = 0;
      let queuedRetainedBytes = 0;
      let pendingEnvelopeCount = 0;
      let pendingEnvelopeBytes = 0;
      let sessionCloseSent = false;
      let closeSessionPromise: Promise<void> | undefined;
      let startupPhase: LiveRuntimeDiagnostic["phase"] = "offer";
      let startupReported = false;

      const takeEvent = (): boolean => {
        const now = clock.now();
        const elapsed = Math.max(0, now - eventBucketAt);
        eventTokens = Math.min(
          LIVE_LIMITS.eventBucket,
          eventTokens + (elapsed / 1_000) * LIVE_LIMITS.eventRefillPerSecond,
        );
        eventBucketAt = now;
        if (eventTokens < 1) return false;
        eventTokens -= 1;
        return true;
      };

      const protocolFailure = (): void =>
        failActive("protocol-error", "protocol");

      const emitTranscript = (
        role: "user" | "assistant",
        text: string,
      ): void => {
        const retained = utf8Tail(text, LIVE_LIMITS.textBytes);
        latestTranscripts.set(role, retained);
        try {
          options.callbacks?.onTranscript?.({ role, text: retained });
        } catch {
          // Caller callbacks are isolated from transport ownership.
        }
      };

      const processEvent = (payload: string): void => {
        if (!active || input.signal.aborted || closeController.signal.aborted)
          return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(payload) as unknown;
        } catch {
          protocolFailure();
          return;
        }
        if (!isUnknownRecord(parsed) || typeof parsed.type !== "string") {
          protocolFailure();
          return;
        }
        switch (parsed.type) {
          case "session.started":
          case "session.updated": {
            const session = parsed.session;
            if (
              !isUnknownRecord(session) ||
              !validCredentialField(session.id, LIVE_LIMITS.idBytes)
            )
              protocolFailure();
            return;
          }
          case "input_transcript.added":
          case "output_transcript.added": {
            const item = parsed.item;
            if (
              !isUnknownRecord(item) ||
              typeof item.text !== "string" ||
              !isValidUtf8String(item.text)
            ) {
              protocolFailure();
              return;
            }
            emitTranscript(
              parsed.type === "input_transcript.added" ? "user" : "assistant",
              item.text,
            );
            return;
          }
          case "turn.done": {
            const turn = parsed.turn;
            if (
              !isUnknownRecord(turn) ||
              (turn.role !== "user" && turn.role !== "assistant") ||
              typeof turn.transcript !== "string" ||
              !isValidUtf8String(turn.transcript)
            ) {
              protocolFailure();
              return;
            }
            emitTranscript(turn.role, turn.transcript);
            return;
          }
          case "delegation.created": {
            const item = parsed.item;
            if (
              !isUnknownRecord(item) ||
              item.type !== "delegation" ||
              item.target !== "client" ||
              !validCredentialField(item.id, LIVE_LIMITS.idBytes) ||
              !Array.isArray(item.content) ||
              item.content.length === 0 ||
              item.content.length > LIVE_LIMITS.contentEntries
            ) {
              protocolFailure();
              return;
            }
            const content: string[] = [];
            let requestBytes = 0;
            for (const entry of item.content) {
              if (
                !isUnknownRecord(entry) ||
                entry.type !== "input_text" ||
                typeof entry.text !== "string" ||
                !isValidUtf8String(entry.text)
              ) {
                protocolFailure();
                return;
              }
              requestBytes +=
                (content.length === 0 ? 0 : 1) +
                Buffer.byteLength(entry.text, "utf8");
              if (requestBytes > LIVE_LIMITS.textBytes) {
                protocolFailure();
                return;
              }
              content.push(entry.text);
            }
            const joinedRequest = content.join("\n");
            if (!byteLengthWithin(joinedRequest, LIVE_LIMITS.textBytes)) {
              protocolFailure();
              return;
            }
            const request = joinedRequest.trim();
            if (request.length === 0) {
              protocolFailure();
              return;
            }
            const fingerprint = JSON.stringify(content);
            const previous = seenRequests.get(item.id);
            if (previous !== undefined) {
              if (previous !== fingerprint) protocolFailure();
              return;
            }
            if (seenRequests.size >= LIVE_LIMITS.seenIds) {
              protocolFailure();
              return;
            }
            seenRequests.set(item.id, fingerprint);
            if (activeDelegationId !== undefined || requestAdmissionPending) {
              protocolFailure();
              return;
            }
            let admitted = false;
            requestAdmissionPending = true;
            try {
              admitted =
                options.callbacks?.onRequest?.({
                  id: item.id,
                  text: request,
                }) === true;
            } catch {
              // #5 owns request admission; callback failures stay outside wire data.
            } finally {
              requestAdmissionPending = false;
            }
            if (!effectAllowed()) return;
            if (admitted) activeDelegationId = item.id;
            return;
          }
          case "error":
            protocolFailure();
            return;
          case "output_audio.delta":
            if (
              typeof parsed.audio !== "string" ||
              !isValidUtf8String(parsed.audio)
            )
              protocolFailure();
            return;
          default:
            return;
        }
      };

      const receiveText = (bytes: Uint8Array): void => {
        if (!active || input.signal.aborted || closeController.signal.aborted)
          return;
        if (
          !(bytes instanceof Uint8Array) ||
          bytes.byteLength > LIVE_LIMITS.inboundBytes ||
          !takeEvent()
        ) {
          protocolFailure();
          return;
        }
        const payload = decodeUtf8(
          new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        );
        if (payload === undefined) {
          protocolFailure();
          return;
        }
        processEvent(payload);
      };

      const receiveNative = (payload: string): void => {
        if (!active || input.signal.aborted || closeController.signal.aborted)
          return;
        if (
          typeof payload !== "string" ||
          !isValidUtf8String(payload) ||
          !byteLengthWithin(payload, LIVE_LIMITS.inboundBytes) ||
          !takeEvent()
        ) {
          protocolFailure();
          return;
        }
        processEvent(payload);
      };

      function releaseRetained(producer: WriterProducer): void {
        if (!producer.retained) return;
        producer.retained = false;
        queuedRetainedBytes -= producer.retainedBytes;
      }

      function releaseFragment(fragment: WriterFragment): void {
        if (!fragment.charged) return;
        fragment.charged = false;
        pendingEnvelopeCount -= 1;
        pendingEnvelopeBytes -= fragment.framedBytes;
        materializeWaitingProducers();
        startWriter();
      }

      function settleProducer(
        producer: WriterProducer,
        error?: LiveRuntimeError,
      ): void {
        if (producer.settled) return;
        producer.settled = true;
        pendingProducers -= 1;
        releaseRetained(producer);
        if (producer.fragment) {
          releaseFragment(producer.fragment);
          producer.fragment = undefined;
        }
        producer.text = undefined;
        producer.pong = undefined;
        producer.delegationId = undefined;
        if (producer.final) finalProducerPending = false;
        if (error) producer.reject(error);
        else producer.resolve();
      }

      function materializeProducer(producer: WriterProducer): boolean {
        if (producer.fragment) return true;
        if (producer.completed || writerStopped) return false;
        const requiredCapacity =
          producer.kind === "pong"
            ? (producer.pong?.byteLength ?? 0) + LIVE_WEBSOCKET_FRAME_OVERHEAD
            : LIVE_PENDING_ENVELOPE_MAX_BYTES;
        if (
          pendingEnvelopeCount >= LIVE_LIMITS.pendingFragments ||
          pendingEnvelopeBytes + requiredCapacity >
            LIVE_LIMITS.pendingEnvelopeBytes
        )
          return false;

        let payload: string | Uint8Array;
        let nextOffset = producer.offset;
        let completed = true;
        if (producer.kind === "pong") {
          if (!producer.pong) throw fixedRuntimeError("protocol");
          payload = producer.pong;
        } else {
          if (producer.text === undefined || producer.dataKind === undefined)
            throw fixedRuntimeError("protocol");
          const chunk = liveTextChunkAt(producer.text, producer.offset);
          nextOffset = chunk.next;
          completed = nextOffset >= producer.text.length;
          const message = producer.delegationId
            ? {
                type: "delegation.context.append",
                delegation_item_id: producer.delegationId,
                ...(producer.dataKind === "application"
                  ? { channel: "commentary" }
                  : {}),
                content: [{ type: "input_text", text: chunk.text }],
              }
            : {
                type: "session.context.append",
                channel: "commentary",
                content: [{ type: "input_text", text: chunk.text }],
              };
          payload = JSON.stringify(message);
        }
        const payloadBytes =
          typeof payload === "string"
            ? Buffer.byteLength(payload, "utf8")
            : payload.byteLength;
        if (
          (producer.kind === "pong" &&
            payloadBytes > LIVE_CONTROL_FRAME_BYTES) ||
          payloadBytes + LIVE_WEBSOCKET_FRAME_OVERHEAD >
            LIVE_PENDING_ENVELOPE_MAX_BYTES
        )
          throw fixedRuntimeError("protocol");
        const framedBytes = payloadBytes + LIVE_WEBSOCKET_FRAME_OVERHEAD;
        if (
          pendingEnvelopeCount >= LIVE_LIMITS.pendingFragments ||
          pendingEnvelopeBytes + framedBytes > LIVE_LIMITS.pendingEnvelopeBytes
        )
          return false;
        producer.offset = nextOffset;
        producer.completed = completed;
        producer.fragment = {
          kind: producer.kind,
          payload,
          framedBytes,
          charged: true,
        };
        pendingEnvelopeCount += 1;
        pendingEnvelopeBytes += framedBytes;
        return true;
      }

      function materializeWaitingProducers(): void {
        if (writerStopped) return;
        for (let index = 0; index < producerQueue.length;) {
          const producer = producerQueue[index]!;
          if (producer.fragment) {
            index += 1;
            continue;
          }
          const reserveActiveFragment =
            activeProducer !== undefined && !activeProducer.completed;
          if (
            pendingEnvelopeCount + 1 + (reserveActiveFragment ? 1 : 0) >
              LIVE_LIMITS.pendingFragments ||
            pendingEnvelopeBytes +
              LIVE_PENDING_ENVELOPE_MAX_BYTES +
              (reserveActiveFragment ? LIVE_PENDING_ENVELOPE_MAX_BYTES : 0) >
              LIVE_LIMITS.pendingEnvelopeBytes
          )
            break;
          try {
            if (!materializeProducer(producer)) break;
            index += 1;
          } catch {
            producerQueue.splice(index, 1);
            settleProducer(producer, fixedRuntimeError("protocol"));
          }
        }
      }

      const waitForCapacity = (
        socket: LiveSidebandSocket,
        framedBytes: number,
        deadline: number,
        sendSignal: AbortSignal,
      ): Promise<void> =>
        new Promise<void>((resolve, reject) => {
          let pollTimer: LiveTimer | undefined;
          let deadlineTimer: LiveTimer | undefined;
          let settled = false;
          const cleanup = () => {
            if (pollTimer) clock.clearTimer(pollTimer);
            if (deadlineTimer) clock.clearTimer(deadlineTimer);
            sendSignal.removeEventListener("abort", onAbort);
          };
          const finish = (error?: LiveRuntimeError) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (error) reject(error);
            else resolve();
          };
          const onAbort = () => finish(fixedRuntimeError("cancelled"));
          const observeDeadline = () => {
            if (clock.now() < deadline) {
              deadlineTimer = clock.setTimer(
                observeDeadline,
                deadline - clock.now(),
              );
              return;
            }
            finish(fixedRuntimeError("timeout"));
          };
          const check = () => {
            if (sendSignal.aborted || !effectAllowed())
              return finish(fixedRuntimeError("cancelled"));
            if (clock.now() >= deadline)
              return finish(fixedRuntimeError("timeout"));
            let buffered: number;
            try {
              buffered = socket.bufferedAmount();
            } catch {
              return finish(fixedRuntimeError("protocol"));
            }
            if (
              !Number.isSafeInteger(buffered) ||
              buffered < 0 ||
              buffered > LIVE_LIMITS.socketHighWaterBytes
            )
              return finish(fixedRuntimeError("protocol"));
            if (buffered + framedBytes <= LIVE_LIMITS.socketHighWaterBytes)
              return finish();
            pollTimer = clock.setTimer(
              check,
              Math.min(10, deadline - clock.now()),
            );
          };
          if (sendSignal.aborted || clock.now() >= deadline) {
            finish(
              sendSignal.aborted
                ? fixedRuntimeError("cancelled")
                : fixedRuntimeError("timeout"),
            );
            return;
          }
          sendSignal.addEventListener("abort", onAbort, { once: true });
          deadlineTimer = clock.setTimer(
            observeDeadline,
            deadline - clock.now(),
          );
          check();
        });

      const sendChecked = async (
        fragment: WriterFragment,
        sendSignal: AbortSignal,
        deadline: number,
      ): Promise<void> => {
        const socket = sideband;
        if (!socket || closeController.signal.aborted) {
          releaseFragment(fragment);
          throw fixedRuntimeError("cancelled");
        }
        try {
          await waitForCapacity(
            socket,
            fragment.framedBytes,
            deadline,
            sendSignal,
          );
        } catch (error) {
          releaseFragment(fragment);
          throw error;
        }
        if (sendSignal.aborted || !effectAllowed()) {
          releaseFragment(fragment);
          throw fixedRuntimeError("cancelled");
        }
        let operation: Promise<void>;
        try {
          operation =
            fragment.kind === "text"
              ? socket.sendText(fragment.payload as string)
              : socket.sendPong(fragment.payload as Uint8Array);
        } catch {
          releaseFragment(fragment);
          throw fixedRuntimeError("protocol");
        }
        pendingSocketSends.add(operation);
        void operation.then(
          () => {
            pendingSocketSends.delete(operation);
            releaseFragment(fragment);
          },
          () => {
            pendingSocketSends.delete(operation);
            releaseFragment(fragment);
          },
        );
        if (clock.now() >= deadline) throw fixedRuntimeError("timeout");
        let timer: LiveTimer | undefined;
        let removeAbort: (() => void) | undefined;
        const cancelled = new Promise<never>((_resolve, reject) => {
          const onAbort = () => reject(fixedRuntimeError("cancelled"));
          sendSignal.addEventListener("abort", onAbort, { once: true });
          removeAbort = () => sendSignal.removeEventListener("abort", onAbort);
          if (sendSignal.aborted) onAbort();
        });
        try {
          await Promise.race([
            operation.catch(() => {
              throw fixedRuntimeError("protocol");
            }),
            cancelled,
            new Promise<never>((_resolve, reject) => {
              const observeDeadline = () => {
                if (clock.now() < deadline) {
                  timer = clock.setTimer(
                    observeDeadline,
                    deadline - clock.now(),
                  );
                  return;
                }
                reject(fixedRuntimeError("timeout"));
              };
              timer = clock.setTimer(observeDeadline, deadline - clock.now());
            }),
          ]);
          if (clock.now() >= deadline) throw fixedRuntimeError("timeout");
        } finally {
          if (timer) clock.clearTimer(timer);
          removeAbort?.();
        }
      };

      function startWriter(): void {
        if (writerRunning || writerStopped) return;
        writerRunning = true;
        void (async () => {
          while (!writerStopped) {
            const producer =
              activeProducer ?? producerQueue.shift() ?? undefined;
            if (!producer) return;
            if (!activeProducer) {
              activeProducer = producer;
              releaseRetained(producer);
            }
            try {
              if (!producer.fragment && !materializeProducer(producer)) return;
              const fragment = producer.fragment!;
              producer.fragment = undefined;
              await sendChecked(fragment, signal, producer.deadline);
              if (writerStopped) throw fixedRuntimeError("cancelled");
              if (producer.completed) {
                activeProducer = undefined;
                settleProducer(producer);
                materializeWaitingProducers();
              }
            } catch (error) {
              activeProducer = undefined;
              settleProducer(
                producer,
                error instanceof LiveRuntimeError
                  ? error
                  : fixedRuntimeError("protocol"),
              );
              materializeWaitingProducers();
            }
          }
        })().finally(() => {
          writerRunning = false;
          if (writerStopped) return;
          if (activeProducer) {
            try {
              if (
                activeProducer.fragment ||
                materializeProducer(activeProducer)
              )
                startWriter();
              return;
            } catch {
              const failed = activeProducer;
              activeProducer = undefined;
              settleProducer(failed, fixedRuntimeError("protocol"));
            }
          }
          materializeWaitingProducers();
          if (producerQueue[0]?.fragment) startWriter();
        });
      }

      const queueProducer = (
        specification:
          | {
              kind: "text";
              text: string;
              dataKind: "application" | "final";
              delegationId?: string;
              final: boolean;
            }
          | { kind: "pong"; pong: Uint8Array; final: false },
        retainedBytes: number,
        deadline: number,
      ): Promise<void> => {
        if (writerStopped || !effectAllowed())
          return Promise.reject(fixedRuntimeError("cancelled"));
        if (
          !Number.isSafeInteger(retainedBytes) ||
          retainedBytes < 0 ||
          pendingProducers >= LIVE_LIMITS.pendingProducers ||
          queuedRetainedBytes + retainedBytes >
            LIVE_LIMITS.retainedProducerBytes ||
          (specification.final && finalProducerPending)
        )
          return Promise.reject(fixedRuntimeError("protocol"));
        let resolveProducer!: () => void;
        let rejectProducer!: (error: LiveRuntimeError) => void;
        const operation = new Promise<void>((resolve, reject) => {
          resolveProducer = resolve;
          rejectProducer = reject;
        });
        const producer: WriterProducer = {
          ...specification,
          offset: 0,
          completed: false,
          retainedBytes,
          retained: true,
          deadline,
          settled: false,
          resolve: resolveProducer,
          reject: rejectProducer,
        };
        pendingProducers += 1;
        queuedRetainedBytes += retainedBytes;
        if (producer.final) finalProducerPending = true;
        producerQueue.push(producer);
        materializeWaitingProducers();
        startWriter();
        return operation;
      };

      const queuePong = (payload: Uint8Array): void => {
        if (!effectAllowed()) return;
        if (
          !(payload instanceof Uint8Array) ||
          payload.byteLength > LIVE_CONTROL_FRAME_BYTES ||
          !takeEvent()
        ) {
          protocolFailure();
          return;
        }
        const retainedPayload = payload.slice();
        void queueProducer(
          { kind: "pong", pong: retainedPayload, final: false },
          retainedPayload.byteLength,
          clock.now() + LIVE_SEND_MS,
        ).catch(() => protocolFailure());
      };

      const cancelWriter = (): void => {
        if (writerStopped) return;
        writerStopped = true;
        const cancellation = fixedRuntimeError("cancelled");
        const current = activeProducer;
        activeProducer = undefined;
        if (current) settleProducer(current, cancellation);
        for (const producer of producerQueue.splice(0))
          settleProducer(producer, cancellation);
      };

      const closeResources = (): Promise<void> => {
        if (closePromise) return closePromise;
        active = false;
        closeController.abort();
        cancelWriter();
        closePromise = (async () => {
          const disposals: Promise<unknown>[] = [];
          if (sidebandStart) {
            const start = sidebandStart;
            sidebandStart = undefined;
            disposals.push(
              start.terminate(async (socket) => {
                if (!(await socket.close())) throw fixedRuntimeError("cleanup");
              }),
            );
          }
          if (peerStart) {
            const start = peerStart;
            peerStart = undefined;
            disposals.push(
              start.terminate(async (ownedPeer) => {
                if (!(await ownedPeer.close()))
                  throw fixedRuntimeError("cleanup");
              }),
            );
          }
          const disposalResult = Promise.allSettled(disposals);
          await Promise.allSettled([...pendingNative, ...pendingSocketSends]);
          const disposalSettled = await disposalResult;
          if (
            transportCleanupUnconfirmed ||
            disposalSettled.some((result) => result.status === "rejected")
          ) {
            report("cleanup-blocked", "cleanup");
            throw fixedRuntimeError("cleanup");
          }
        })();
        return closePromise;
      };

      const operation = (async (): Promise<LiveConnection> => {
        try {
          refuseUnsafeDebug();
        } catch {
          startupReported = true;
          active = false;
          try {
            input.onFailure?.("denied");
          } catch {
            // The generation owner controls its own callback failure.
          }
          throw fixedRuntimeError("protocol");
        }
        const realtimeSessionId = randomId();
        const headers = buildLiveHeaders(
          credentials,
          options.sessionId,
          realtimeSessionId,
          attestation,
        );

        requireEffectAllowed();
        try {
          peerStart = native.createPeer({
            onEvent: receiveNative,
            onOutputLevel: (level) => {
              if (!Number.isFinite(level)) protocolFailure();
            },
            onFailure: () => failActive("protocol-error", "native-open"),
          });
        } catch {
          transportCleanupUnconfirmed = true;
          throw fixedRuntimeError("protocol");
        }
        requireEffectAllowed();
        const startedPeer = peerStart;
        const offerOperation = trackNative(
          startedPeer.result.then((createdPeer) => {
            requireEffectAllowed();
            peer = createdPeer;
            requireEffectAllowed();
            return createdPeer.createOffer();
          }),
        );
        const offer = await waitForRuntimePhase(
          offerOperation,
          input.deadline,
          clock,
          signal,
        );
        const requestBody = buildLiveSessionRequest(
          offer,
          options.instructions,
          input.voice,
        );
        const signalingHeaders = {
          ...headers,
          Accept: "*/*",
          "Content-Type": "application/json",
        };
        if (
          combinedHeaderBytes(signalingHeaders) >
          LIVE_LIMITS.combinedHeaderBytes
        )
          throw fixedRuntimeError("protocol");

        startupPhase = "signaling";
        const signalingDeadline = Math.min(
          input.deadline,
          clock.now() + LIVE_PHASE_MS,
        );
        requireEffectAllowed();
        const signalingProxy = await waitForRuntimePhase(
          Promise.resolve(proxyForUrl(LIVE_SIGNALING_URL)),
          signalingDeadline,
          clock,
          signal,
        );
        requireEffectAllowed();
        let signalingStart: LiveResourceStart<LiveHttpResponse>;
        try {
          signalingStart = network.signal({
            url: LIVE_SIGNALING_URL,
            method: "POST",
            redirect: "manual",
            headers: signalingHeaders,
            body: requestBody,
            ...(signalingProxy ? { proxyUrl: signalingProxy } : {}),
            signal,
          });
        } catch {
          transportCleanupUnconfirmed = true;
          throw fixedRuntimeError("protocol");
        }
        let response: LiveHttpResponse | undefined;
        try {
          requireEffectAllowed();
          response = await waitForRuntimePhase(
            signalingStart.result,
            signalingDeadline,
            clock,
            signal,
          );
          requireEffectAllowed();
          if (
            !Number.isSafeInteger(response.status) ||
            response.status < 200 ||
            response.status > 299
          ) {
            try {
              await waitForRuntimePhase(
                trackOperation(
                  pendingNetworkReads,
                  readBoundedBody(
                    response,
                    LIVE_LIMITS.nonOkBodyBytes,
                    false,
                    signalingDeadline,
                    clock,
                    signal,
                  ),
                ),
                signalingDeadline,
                clock,
                signal,
              );
            } catch (error) {
              if (
                error instanceof LiveRuntimeError &&
                (error.kind === "timeout" ||
                  error.kind === "cancelled" ||
                  error.kind === "cleanup")
              )
                throw error;
            }
            try {
              await response.cancel();
            } catch {
              throw fixedRuntimeError("cleanup");
            }
            startupReported = true;
            failActive("protocol-error", "signaling", response.status);
            throw fixedRuntimeError("protocol");
          }
          const answerBytes = await waitForRuntimePhase(
            trackOperation(
              pendingNetworkReads,
              readBoundedBody(
                response,
                LIVE_LIMITS.sdpBytes,
                true,
                signalingDeadline,
                clock,
                signal,
              ),
            ),
            signalingDeadline,
            clock,
            signal,
          );
          if (answerBytes.byteLength === 0) throw fixedRuntimeError("protocol");
          const answer = decodeUtf8(answerBytes);
          if (answer === undefined) throw fixedRuntimeError("protocol");
          const callId = parseLiveCallLocation(response.location);
          if (!peer) throw fixedRuntimeError("protocol");
          startupPhase = "answer";
          requireEffectAllowed();
          const acceptOperation = trackNative(peer.acceptAnswer(answer));
          await waitForRuntimePhase(
            acceptOperation,
            input.deadline,
            clock,
            signal,
          );
          startupPhase = "native-open";
          requireEffectAllowed();
          const openOperation = trackNative(peer.waitForOpen());
          await waitForRuntimePhase(
            openOperation,
            input.deadline,
            clock,
            signal,
          );
          requireEffectAllowed();
          peer.setMuted(false);

          startupPhase = "sideband";
          const sidebandUrl = `wss://api.openai.com/v1/live/${callId}`;
          requireEffectAllowed();
          const sidebandProxy = await waitForRuntimePhase(
            Promise.resolve(proxyForUrl(sidebandUrl)),
            input.deadline,
            clock,
            signal,
          );
          requireEffectAllowed();
          let currentCandidate: object | undefined;
          for (
            let attemptNumber = 0;
            attemptNumber < LIVE_SIDE_BAND_ATTEMPTS;
            attemptNumber += 1
          ) {
            requireEffectAllowed();
            let candidate: LiveResourceStart<LiveSidebandSocket>;
            const candidateState: {
              token: object;
              adopted: boolean;
              retired: boolean;
              failure?: LiveSidebandFailure;
            } = {
              token: {},
              adopted: false,
              retired: false,
            };
            currentCandidate = candidateState.token;
            const candidateIsCurrent = () =>
              currentCandidate === candidateState.token &&
              !candidateState.retired;
            const failCandidate = (failure: LiveSidebandFailure) => {
              if (!candidateIsCurrent()) return;
              if (candidateState.adopted) {
                failActive("protocol-error", "sideband");
                return;
              }
              candidateState.failure ??= failure;
            };
            try {
              candidate = network.openSideband({
                url: sidebandUrl,
                headers,
                followRedirects: false,
                maxPayloadBytes: LIVE_LIMITS.inboundBytes,
                autoPong: false,
                ...(sidebandProxy ? { proxyUrl: sidebandProxy } : {}),
                signal,
                onText: (payload) => {
                  if (!candidateIsCurrent()) return;
                  if (!candidateState.adopted) {
                    failCandidate({ kind: "malformed" });
                    return;
                  }
                  receiveText(payload);
                },
                onBinary: (payload) => {
                  if (!candidateIsCurrent()) return;
                  if (!candidateState.adopted) {
                    failCandidate({ kind: "malformed" });
                    return;
                  }
                  if (!effectAllowed()) return;
                  if (
                    payload.byteLength > LIVE_LIMITS.inboundBytes ||
                    !takeEvent()
                  ) {
                    protocolFailure();
                    return;
                  }
                  protocolFailure();
                },
                onPing: (payload) => {
                  if (!candidateIsCurrent()) return;
                  if (!candidateState.adopted) {
                    failCandidate({ kind: "malformed" });
                    return;
                  }
                  queuePong(payload);
                },
                onPong: (payload) => {
                  if (!candidateIsCurrent()) return;
                  if (!candidateState.adopted) {
                    failCandidate({ kind: "malformed" });
                    return;
                  }
                  if (!effectAllowed()) return;
                  if (
                    payload.byteLength > LIVE_CONTROL_FRAME_BYTES ||
                    !takeEvent()
                  )
                    protocolFailure();
                },
                onFailure: failCandidate,
                onClose: () => failCandidate({ kind: "malformed" }),
              });
            } catch {
              candidateState.retired = true;
              currentCandidate = undefined;
              transportCleanupUnconfirmed = true;
              throw fixedRuntimeError("protocol");
            }
            try {
              requireEffectAllowed();
              const opened = await waitForRuntimePhase(
                candidate.result,
                input.deadline,
                clock,
                signal,
              );
              requireEffectAllowed();
              if (candidateState.failure) throw candidateState.failure;
              candidateState.adopted = true;
              sidebandStart = candidate;
              sideband = opened;
              break;
            } catch (failure) {
              const observedFailure = candidateState.failure ?? failure;
              candidateState.retired = true;
              if (currentCandidate === candidateState.token)
                currentCandidate = undefined;
              try {
                await candidate.terminate(async (socket) => {
                  if (!(await socket.close()))
                    throw fixedRuntimeError("cleanup");
                });
              } catch {
                transportCleanupUnconfirmed = true;
                throw fixedRuntimeError("cleanup");
              }
              if (
                observedFailure instanceof LiveRuntimeError &&
                (observedFailure.kind === "timeout" ||
                  observedFailure.kind === "cancelled")
              )
                throw observedFailure;
              const transient = sidebandFailureIsTransient(observedFailure);
              if (!transient || attemptNumber + 1 >= LIVE_SIDE_BAND_ATTEMPTS)
                throw fixedRuntimeError("protocol");
              const backoff = 200 * 2 ** attemptNumber;
              const remaining = input.deadline - clock.now();
              if (remaining <= 0) throw fixedRuntimeError("timeout");
              await waitWithClock(clock, Math.min(backoff, remaining), signal);
              if (clock.now() >= input.deadline)
                throw fixedRuntimeError("timeout");
            }
          }
          if (!sideband || !peer) throw fixedRuntimeError("protocol");
        } finally {
          try {
            await signalingStart.terminate(async (ownedResponse) =>
              ownedResponse.cancel(),
            );
          } catch {
            transportCleanupUnconfirmed = true;
            throw fixedRuntimeError("cleanup");
          } finally {
            await Promise.allSettled([...pendingNetworkReads]);
          }
        }

        connection = {
          startCapture(onSample) {
            requireEffectAllowed();
            try {
              return native.startCapture({
                onSample(samples) {
                  if (effectAllowed()) onSample(samples);
                },
                onFailure() {
                  failActive("audio-error", "audio");
                },
              });
            } catch {
              transportCleanupUnconfirmed = true;
              throw fixedRuntimeError("protocol");
            }
          },
          sendSample(samples) {
            if (!peer) throw fixedRuntimeError("cancelled");
            requireEffectAllowed();
            peer.pushAudio(samples);
            let sum = 0;
            for (const sample of samples) sum += sample * sample;
            options.callbacks?.onLevel?.(
              samples.length === 0
                ? 0
                : Math.min(1, Math.sqrt(sum / samples.length)),
            );
          },
          sendData(data) {
            if (!effectAllowed() || !sideband)
              return Promise.reject(fixedRuntimeError("cancelled"));
            if (
              (data.kind !== "application" && data.kind !== "final") ||
              typeof data.text !== "string" ||
              !isValidUtf8String(data.text)
            )
              return Promise.reject(fixedRuntimeError("protocol"));
            const dataKind = data.kind;
            if (
              dataKind === "application" &&
              !byteLengthWithin(data.text, LIVE_LIMITS.textBytes)
            )
              return Promise.reject(fixedRuntimeError("protocol"));
            const delegationId = activeDelegationId;
            if (dataKind === "final" && !delegationId)
              return Promise.reject(fixedRuntimeError("protocol"));
            const boundedText =
              dataKind === "final" ? truncateLiveFinal(data.text) : data.text;
            const text =
              dataKind === "final"
                ? `"Agent Final Message":\n\n${boundedText}`
                : boundedText;
            const deadline = clock.now() + LIVE_SEND_MS;
            const operation = queueProducer(
              {
                kind: "text",
                text,
                dataKind,
                ...(delegationId ? { delegationId } : {}),
                final: dataKind === "final",
              },
              Buffer.byteLength(text, "utf8"),
              deadline,
            );
            if (dataKind === "final")
              void operation.then(
                () => {
                  if (activeDelegationId === delegationId)
                    activeDelegationId = undefined;
                },
                () => undefined,
              );
            return operation;
          },
          closeSession(request) {
            if (
              sessionCloseSent ||
              request.signal.aborted ||
              closeController.signal.aborted ||
              !sideband
            )
              return;
            sessionCloseSent = true;
            if (clock.now() >= request.deadline) return;
            const socket = sideband;
            const payload = '{"type":"session.close"}';
            const framedBytes =
              Buffer.byteLength(payload, "utf8") +
              LIVE_WEBSOCKET_FRAME_OVERHEAD;
            let buffered: number;
            try {
              buffered = socket.bufferedAmount();
            } catch {
              return;
            }
            if (
              !Number.isSafeInteger(buffered) ||
              buffered < 0 ||
              buffered > LIVE_LIMITS.socketHighWaterBytes ||
              buffered + pendingEnvelopeBytes + framedBytes >
                LIVE_LIMITS.socketHighWaterBytes
            )
              return;
            pendingEnvelopeBytes += framedBytes;
            let operation: Promise<void>;
            try {
              operation = socket.sendText(payload);
            } catch {
              pendingEnvelopeBytes -= framedBytes;
              return;
            }
            pendingSocketSends.add(operation);
            void operation.then(
              () => {
                pendingSocketSends.delete(operation);
                pendingEnvelopeBytes -= framedBytes;
              },
              () => {
                pendingSocketSends.delete(operation);
                pendingEnvelopeBytes -= framedBytes;
              },
            );
            closeSessionPromise = operation.catch(() => {
              throw fixedRuntimeError("protocol");
            });
            return closeSessionPromise;
          },
          close: closeResources,
        };
        return connection;
      })().catch((error: unknown) => {
        const closed =
          error instanceof LiveRuntimeError
            ? error
            : fixedRuntimeError("protocol");
        if (
          !startupReported &&
          !(input.signal.aborted && closed.kind === "cancelled")
        )
          failActive(
            closed.kind === "timeout"
              ? "connect-timeout"
              : closed.kind === "cleanup"
                ? "cleanup-blocked"
                : "protocol-error",
            closed.kind === "cleanup" ? "cleanup" : startupPhase,
          );
        throw closed;
      });
      void operation.catch(() => undefined);

      return {
        result: operation,
        async terminate(dispose): Promise<void> {
          closeController.abort();
          const cleanup = closeResources();
          const settled = await operation.then(
            (value) => ({ kind: "value" as const, value }),
            () => ({ kind: "error" as const }),
          );
          if (settled.kind === "value") await dispose(settled.value);
          await cleanup;
        },
      };
    },
  };
}

interface DefaultNativeCapture {
  stop(): void;
}

interface DefaultNativePeer {
  createOffer(): Promise<string>;
  acceptAnswer(answer: string): Promise<void>;
  waitForOpen(timeoutMs?: number): Promise<void>;
  pushAudio(samples: Float32Array): void;
  setMuted(muted: boolean): void;
  close(): Promise<void>;
}

interface DefaultNativeBindings {
  AudioCapture: new (
    sampleRate: number,
    callback: (error: Error | null, samples: Float32Array) => void,
  ) => DefaultNativeCapture;
  LiveWebRtcPeer: new (
    onEvent: (error: Error | null, payload: string) => void,
    onLevel: (error: Error | null, level: number) => void,
    onFailure: (error: Error | null, message: string) => void,
  ) => DefaultNativePeer;
  deviceCheckGenerateToken(): Promise<LiveDeviceCheckResult>;
  __ompInstallTokioRuntime(): void;
}

const LIVE_NATIVE_PACKAGES = {
  "darwin-arm64": "@oh-my-pi/pi-natives-darwin-arm64",
  "darwin-x64": "@oh-my-pi/pi-natives-darwin-x64",
  "linux-arm64": "@oh-my-pi/pi-natives-linux-arm64",
  "linux-x64": "@oh-my-pi/pi-natives-linux-x64",
  "win32-x64": "@oh-my-pi/pi-natives-win32-x64",
} as const;
const liveRuntimeRequire = createRequire(import.meta.url);
let defaultNativeBindings: DefaultNativeBindings | undefined;

function loadDefaultLiveNativeBindings(): DefaultNativeBindings {
  if (defaultNativeBindings) return defaultNativeBindings;
  const packageName =
    LIVE_NATIVE_PACKAGES[
      `${process.platform}-${process.arch}` as keyof typeof LIVE_NATIVE_PACKAGES
    ];
  if (!packageName) throw new Error("Live native target is unsupported.");
  const loaded: unknown = liveRuntimeRequire(packageName);
  if (
    !isUnknownRecord(loaded) ||
    typeof loaded.AudioCapture !== "function" ||
    typeof loaded.LiveWebRtcPeer !== "function" ||
    typeof loaded.deviceCheckGenerateToken !== "function" ||
    typeof loaded.__ompInstallTokioRuntime !== "function"
  )
    throw new Error("Live native bindings are invalid.");
  const bindings = loaded as unknown as DefaultNativeBindings;
  bindings.__ompInstallTokioRuntime();
  defaultNativeBindings = bindings;
  return bindings;
}

function createDefaultLiveNativeAdapter(): LiveNativeAdapter {
  return {
    deviceCheck: {
      async generateToken(): Promise<LiveDeviceCheckResult> {
        return loadDefaultLiveNativeBindings().deviceCheckGenerateToken();
      },
    },
    createPeer(input) {
      let nativePeer: DefaultNativePeer;
      try {
        const bindings = loadDefaultLiveNativeBindings();
        nativePeer = new bindings.LiveWebRtcPeer(
          (error, payload) => {
            if (error) input.onFailure();
            else input.onEvent(payload);
          },
          (error, level) => {
            if (error) input.onFailure();
            else input.onOutputLevel(level);
          },
          () => input.onFailure(),
        );
      } catch {
        throw new Error("Live native peer could not be constructed.");
      }
      const peer: LiveNativePeer = {
        createOffer: () => nativePeer.createOffer(),
        acceptAnswer: (answer) => nativePeer.acceptAnswer(answer),
        waitForOpen: () => nativePeer.waitForOpen(),
        pushAudio: (samples) => nativePeer.pushAudio(samples),
        setMuted: (muted) => nativePeer.setMuted(muted),
        async close(): Promise<boolean> {
          try {
            await nativePeer.close();
          } catch {
            return false;
          }
          // The pinned native promise does not join every hidden peer/speaker task.
          return false;
        },
      };
      let termination: Promise<void> | undefined;
      return {
        result: Promise.resolve(peer),
        terminate(dispose) {
          termination ??= dispose(peer);
          return termination;
        },
      };
    },
    startCapture(input) {
      let nativeCapture: DefaultNativeCapture;
      try {
        const bindings = loadDefaultLiveNativeBindings();
        nativeCapture = new bindings.AudioCapture(16_000, (error, samples) => {
          if (error) input.onFailure();
          else input.onSample(samples);
        });
      } catch {
        throw new Error("Live audio capture could not be constructed.");
      }
      let stopped = false;
      const capture: LiveCapture = {
        async stop(): Promise<void> {
          if (stopped) return;
          stopped = true;
          nativeCapture.stop();
        },
      };
      let termination: Promise<void> | undefined;
      return {
        result: Promise.resolve(capture),
        terminate(dispose) {
          termination ??= dispose(capture);
          return termination;
        },
      };
    },
  };
}

interface DefaultWebSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  on(event: string, listener: (...args: unknown[]) => void): void;
  once(event: string, listener: (...args: unknown[]) => void): void;
  send(payload: string, callback: (error?: Error) => void): void;
  pong(payload: Uint8Array, callback: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

interface DefaultWebSocketConstructor {
  new (url: string, options: Record<string, unknown>): DefaultWebSocket;
}

interface DefaultHttpsProxyAgentConstructor {
  new (url: string): { destroy(): void };
}

export interface LiveNetworkDispatcher {
  destroy(): Promise<void>;
}

export interface LiveNetworkFetchResponse {
  status: number;
  statusText: string;
  headers: { get(name: string): string | null };
  body: (AsyncIterable<Uint8Array> & { cancel(): Promise<void> }) | null;
}

export interface LiveDefaultHttpDependencies {
  createHttpAgent(): LiveNetworkDispatcher;
  createHttpProxyAgent(url: string): LiveNetworkDispatcher;
  fetch(
    url: string,
    input: {
      method: "POST";
      redirect: "manual";
      headers: Record<string, string>;
      body: string;
      signal: AbortSignal;
      dispatcher: LiveNetworkDispatcher;
    },
  ): Promise<LiveNetworkFetchResponse>;
}

export interface LiveDefaultNetworkDependencies extends LiveDefaultHttpDependencies {
  loadHttp?(): Promise<LiveDefaultHttpDependencies>;
  createWebSocket(
    url: string,
    options: Record<string, unknown>,
  ): DefaultWebSocket;
  createWebSocketProxyAgent(url: string): { destroy(): void | Promise<void> };
}

function classifyWebSocketFailure(error: unknown): LiveSidebandFailure {
  const code =
    isUnknownRecord(error) && typeof error.code === "string"
      ? error.code
      : undefined;
  return code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "EAI_AGAIN" ||
    code === "ENETUNREACH" ||
    code === "EHOSTUNREACH" ||
    code === "EPIPE" ||
    code === "UND_ERR_CONNECT_TIMEOUT"
    ? { kind: "transient" }
    : { kind: "malformed" };
}

function webSocketBytes(
  value: unknown,
  maximum: number,
): Uint8Array | undefined {
  if (value instanceof Uint8Array)
    return value.byteLength <= maximum ? value : undefined;
  if (value instanceof ArrayBuffer) {
    if (value.byteLength > maximum) return undefined;
    return new Uint8Array(value);
  }
  if (
    Array.isArray(value) &&
    value.every((part) => part instanceof Uint8Array)
  ) {
    const length = value.reduce((total, part) => total + part.byteLength, 0);
    if (length > maximum) return undefined;
    const joined = new Uint8Array(length);
    let offset = 0;
    for (const part of value) {
      joined.set(part, offset);
      offset += part.byteLength;
    }
    return joined;
  }
  return undefined;
}

async function loadDefaultLiveHttpDependencies(): Promise<LiveDefaultHttpDependencies> {
  const undici = await import("undici");
  return {
    createHttpAgent: () => new undici.Agent(),
    createHttpProxyAgent: (url) => new undici.ProxyAgent(url),
    fetch: async (url, input) =>
      (await undici.fetch(url, {
        method: input.method,
        redirect: input.redirect,
        headers: input.headers,
        body: input.body,
        signal: input.signal,
        dispatcher: input.dispatcher as Dispatcher,
      })) as unknown as LiveNetworkFetchResponse,
  };
}

export function createDefaultLiveNetworkAdapter(
  dependencies?: LiveDefaultNetworkDependencies,
): LiveNetworkAdapter {
  return {
    signal(input) {
      const controller = new AbortController();
      const signal = AbortSignal.any([input.signal, controller.signal]);
      let dispatcher: LiveNetworkDispatcher | undefined;
      let response: LiveHttpResponse | undefined;
      const result = (async (): Promise<LiveHttpResponse> => {
        if (signal.aborted) throw fixedRuntimeError("cancelled");
        const http = dependencies?.loadHttp
          ? await dependencies.loadHttp()
          : (dependencies ?? (await loadDefaultLiveHttpDependencies()));
        if (signal.aborted) throw fixedRuntimeError("cancelled");
        dispatcher = input.proxyUrl
          ? http.createHttpProxyAgent(input.proxyUrl)
          : http.createHttpAgent();
        if (signal.aborted) throw fixedRuntimeError("cancelled");
        const fetched = await http.fetch(input.url, {
          method: input.method,
          redirect: input.redirect,
          headers: input.headers,
          body: input.body,
          signal,
          dispatcher,
        });
        if (signal.aborted) throw fixedRuntimeError("cancelled");
        const body = fetched.body;
        const bodyIterator = body?.[Symbol.asyncIterator]();
        let bodyClaimed = false;
        const ownedBody: AsyncIterable<Uint8Array> = bodyIterator
          ? {
              [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
                if (bodyClaimed) throw fixedRuntimeError("protocol");
                bodyClaimed = true;
                return bodyIterator;
              },
            }
          : (async function* () {})();
        let cancellation: Promise<void> | undefined;
        response = {
          status: fetched.status,
          statusText: fetched.statusText,
          location: fetched.headers.get("location") ?? undefined,
          body: ownedBody,
          cancel(): Promise<void> {
            cancellation ??= (async () => {
              controller.abort();
              await bodyIterator?.return?.();
            })();
            return cancellation;
          },
        };
        return response;
      })();
      void result.catch(() => undefined);
      let termination: Promise<void> | undefined;
      return {
        result,
        terminate(dispose) {
          termination ??= (async () => {
            const cleanupErrors: unknown[] = [];
            if (!response) controller.abort();
            const settled = await result.then(
              (value) => value,
              () => undefined,
            );
            if (settled) {
              try {
                await dispose(settled);
              } catch (error) {
                cleanupErrors.push(error);
              }
            }
            try {
              await dispatcher?.destroy();
            } catch (error) {
              cleanupErrors.push(error);
            }
            if (cleanupErrors.length > 0) throw fixedRuntimeError("cleanup");
          })();
          return termination;
        },
      };
    },
    openSideband(input) {
      const controller = new AbortController();
      const signal = AbortSignal.any([input.signal, controller.signal]);
      let socket: DefaultWebSocket | undefined;
      let proxyAgent: { destroy(): void | Promise<void> } | undefined;
      let opened = false;
      let closing = false;
      let closeObserved = false;
      let constructionUnconfirmed = false;
      let socketClosure: Promise<boolean> | undefined;
      let resolveClosed: (() => void) | undefined;
      const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });
      const closeSocket = (): Promise<boolean> => {
        if (socketClosure) return socketClosure;
        closing = true;
        socketClosure = (async () => {
          if (!socket) return !constructionUnconfirmed && !input.proxyUrl;
          if (closeObserved) return !input.proxyUrl;
          try {
            if (
              socket.readyState === 0 ||
              socket.readyState === 1 ||
              socket.readyState === 2
            )
              socket.terminate();
            else return false;
          } catch {
            return false;
          }
          await closed;
          return !input.proxyUrl;
        })();
        return socketClosure;
      };
      const result = (async (): Promise<LiveSidebandSocket> => {
        if (signal.aborted) throw { kind: "cancelled" as const };
        try {
          if (input.proxyUrl)
            proxyAgent = dependencies
              ? dependencies.createWebSocketProxyAgent(input.proxyUrl)
              : new (
                  liveRuntimeRequire("https-proxy-agent") as {
                    HttpsProxyAgent: DefaultHttpsProxyAgentConstructor;
                  }
                ).HttpsProxyAgent(input.proxyUrl);
          const socketOptions = {
            headers: input.headers,
            followRedirects: input.followRedirects,
            maxPayload: input.maxPayloadBytes,
            autoPong: input.autoPong,
            ...(proxyAgent ? { agent: proxyAgent } : {}),
          };
          if (dependencies) {
            socket = dependencies.createWebSocket(input.url, socketOptions);
          } else {
            const loadedWebSocket: unknown = liveRuntimeRequire("ws");
            const WebSocket =
              typeof loadedWebSocket === "function"
                ? (loadedWebSocket as DefaultWebSocketConstructor)
                : (
                    loadedWebSocket as {
                      default: DefaultWebSocketConstructor;
                    }
                  ).default;
            socket = new WebSocket(input.url, socketOptions);
          }
        } catch {
          constructionUnconfirmed = true;
          throw { kind: "malformed" as const };
        }
        const created = socket;
        const openedPromise = new Promise<LiveSidebandSocket>(
          (resolve, reject) => {
            const failBeforeOpen = (failure: LiveSidebandFailure) => {
              if (!opened) reject(failure);
            };
            created.once("open", () => {
              opened = true;
              const adapter: LiveSidebandSocket = {
                bufferedAmount: () => created.bufferedAmount,
                sendText(payload) {
                  return new Promise<void>((resolveSend, rejectSend) => {
                    try {
                      created.send(payload, (error) => {
                        if (error) rejectSend(fixedRuntimeError("protocol"));
                        else resolveSend();
                      });
                    } catch {
                      rejectSend(fixedRuntimeError("protocol"));
                    }
                  });
                },
                sendPong(payload) {
                  return new Promise<void>((resolveSend, rejectSend) => {
                    try {
                      created.pong(payload, (error) => {
                        if (error) rejectSend(fixedRuntimeError("protocol"));
                        else resolveSend();
                      });
                    } catch {
                      rejectSend(fixedRuntimeError("protocol"));
                    }
                  });
                },
                close: closeSocket,
              };
              resolve(adapter);
            });
            created.on("message", (...args) => {
              const bytes = webSocketBytes(args[0], input.maxPayloadBytes);
              if (!bytes) {
                input.onBinary(new Uint8Array(input.maxPayloadBytes + 1));
                return;
              }
              if (args[1] === true) input.onBinary(bytes);
              else input.onText(bytes);
            });
            created.on("ping", (...args) => {
              const bytes = webSocketBytes(args[0], LIVE_CONTROL_FRAME_BYTES);
              input.onPing(
                bytes ?? new Uint8Array(LIVE_CONTROL_FRAME_BYTES + 1),
              );
            });
            created.on("pong", (...args) => {
              const bytes = webSocketBytes(args[0], LIVE_CONTROL_FRAME_BYTES);
              input.onPong(
                bytes ?? new Uint8Array(LIVE_CONTROL_FRAME_BYTES + 1),
              );
            });
            created.on("unexpected-response", (...args) => {
              const responseValue = args[1];
              const status =
                isUnknownRecord(responseValue) &&
                typeof responseValue.statusCode === "number"
                  ? responseValue.statusCode
                  : 0;
              const readable = responseValue as
                { resume?: () => void; destroy?: () => void } | undefined;
              readable?.resume?.();
              readable?.destroy?.();
              failBeforeOpen({ kind: "http", status });
            });
            created.on("error", (...args) => {
              const failure = classifyWebSocketFailure(args[0]);
              if (opened) input.onFailure(failure);
              else failBeforeOpen(failure);
            });
            created.on("close", (...args) => {
              closeObserved = true;
              resolveClosed?.();
              if (opened && !closing) input.onClose();
              else if (!opened) {
                const code = typeof args[0] === "number" ? args[0] : 0;
                failBeforeOpen(
                  code === 1006 || code === 1012 || code === 1013
                    ? { kind: "transient" }
                    : { kind: "malformed" },
                );
              }
            });
            const onAbort = () => {
              void closeSocket();
              failBeforeOpen({ kind: "cancelled" });
            };
            if (signal.aborted) onAbort();
            else signal.addEventListener("abort", onAbort, { once: true });
          },
        );
        return openedPromise;
      })();
      void result.catch(() => undefined);
      let termination: Promise<void> | undefined;
      return {
        result,
        terminate(dispose) {
          termination ??= (async () => {
            controller.abort();
            let confirmed = false;
            let cleanupFailed = false;
            const settled = await result.then(
              (value) => value,
              () => undefined,
            );
            try {
              if (settled) {
                await dispose(settled);
                confirmed = closeObserved && !input.proxyUrl;
              } else {
                confirmed = await closeSocket();
              }
            } catch {
              cleanupFailed = true;
            }
            try {
              await proxyAgent?.destroy();
            } catch {
              cleanupFailed = true;
            }
            if (!confirmed || cleanupFailed) throw fixedRuntimeError("cleanup");
          })();
          return termination;
        },
      };
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
  ): (samples: Float32Array) => void {
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
      if (
        !(samples instanceof Float32Array) ||
        samples.length > LIVE_LIMITS.microphoneSamples ||
        samples.some((sample) => !Number.isFinite(sample))
      ) {
        void beginStop(current, "audio-error");
        return;
      }
      if (samples.length === 0) return;
      const now = clock.now();
      const elapsed = Math.max(0, now - current.microphoneBucketAt);
      current.microphoneTokens = Math.min(
        LIVE_LIMITS.microphoneBucket,
        current.microphoneTokens +
          (elapsed / 1_000) * LIVE_LIMITS.microphoneRefillPerSecond,
      );
      current.microphoneBucketAt = now;
      if (samples.length > current.microphoneTokens) {
        void beginStop(current, "audio-error");
        return;
      }
      current.microphoneTokens -= samples.length;
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
      microphoneTokens: LIVE_LIMITS.microphoneBucket,
      microphoneBucketAt: clock.now(),
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
        return resources.attestation({
          signal: current.controller.signal,
          credentials: credentialResult.value,
        });
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
    );
    if (clock.now() >= connectionDeadline) {
      void beginStop(current, "connect-timeout");
      return { kind: "cancelled", state };
    }
    let connectionStart: ReturnType<typeof trackedStart<LiveConnection>>;
    try {
      connectionStart = trackedStart(
        current,
        () =>
          resources.connect({
            signal: current.controller.signal,
            deadline: connectionDeadline,
            credentials: credentialResult.value,
            attestation: attestationResult.value,
            voice: current.voice,
            onFailure(diagnostic) {
              if (attempt === current && currentAttempt(current))
                void beginStop(current, diagnostic);
            },
          }),
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
    text
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, " "),
    width,
    "",
  );
}

export interface LiveDependencies {
  preferences: PreferenceStore;
  compatibility: CompatibilityChecker;
  truncateToWidth: TruncateToWidth;
  packageSources?(ctx: ExtensionContext): Promise<readonly string[]>;
  runtime?: {
    lifecycle?: Omit<
      LiveLifecycleOptions,
      "admission" | "consent" | "resources"
    >;
    resources?(options: LiveRuntimeResourcesOptions): LiveResources;
    executionHost?(): string;
    configuredPackageSources?: readonly string[];
  };
}

async function readLiveSettings(file: string): Promise<string | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size > 1_024 * 1_024)
      throw new Error("settings unavailable");
    const bytes = Buffer.alloc(1_024 * 1_024 + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        length,
        bytes.length - length,
        null,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > 1_024 * 1_024) throw new Error("settings unavailable");
    return bytes.subarray(0, length).toString("utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function configuredLivePackageSources(
  ctx: ExtensionContext,
): Promise<readonly string[]> {
  const projectTrusted = ctx.isProjectTrusted();
  const [global, project] = await Promise.all([
    readLiveSettings(path.join(getAgentDir(), "settings.json")),
    projectTrusted
      ? readLiveSettings(path.join(ctx.cwd, CONFIG_DIR_NAME, "settings.json"))
      : undefined,
  ]);
  // Use Pi's public parser/migrations with immutable read snapshots. The ordinary
  // file-backed SettingsManager takes file locks even to read; this backend
  // never writes settings or creates locks before consent.
  const settings = SettingsManager.fromStorage(
    {
      withLock(scope, read) {
        if (read(scope === "global" ? global : project) !== undefined)
          throw new Error("settings are read-only");
      },
    },
    { projectTrusted },
  );
  if (settings.drainErrors().length) throw new Error("settings unavailable");
  const sources: string[] = [];
  for (const value of [
    settings.getGlobalSettings(),
    settings.getProjectSettings(),
  ]) {
    if (!isUnknownRecord(value)) throw new Error("settings unavailable");
    const packages: unknown = value.packages;
    if (packages === undefined) continue;
    if (!Array.isArray(packages)) throw new Error("settings unavailable");
    for (const entry of packages) {
      if (typeof entry === "string") sources.push(entry);
      else if (isUnknownRecord(entry) && typeof entry.source === "string")
        sources.push(entry.source);
      else throw new Error("settings unavailable");
    }
  }
  return sources;
}

export function createLiveDependencies(
  truncateToWidth: TruncateToWidth,
): LiveDependencies {
  return {
    preferences: createFilePreferenceStore(),
    compatibility: createCompatibilityChecker(),
    truncateToWidth,
    packageSources: configuredLivePackageSources,
  };
}

const LIVE_DISCLOSURE =
  "Uses the execution host microphone and speakers with the experimental OpenAI service. Audio, speech transcripts, the Pi session identifier (linking calls from that session), and only the final coding result are shared. DeviceCheck attestation and locale/timezone metadata are sent. Existing HTTP/WebSocket proxy settings do not establish WebRTC/ICE media proxying. Pi reports only outermost extension dialogs, with a microtask delay; shortcut-opened dialogs and unreported nested dialogs may leave voice active. Stop voice first before opening such dialogs when capture and delivery must stop. Muting stops microphone capture; speakers may continue. Voice requests do not grant approvals. Native/proxy cleanup may remain unconfirmed and block restart; home certification and recovery require standalone setup.";

const LIVE_INSTRUCTIONS = `You are Pi Live, the voice surface of the user's coding assistant. Reply briefly in speech-friendly language. For coding, repository investigation, tools, commands or verification, create one client delegation containing the complete request and relevant spoken context. The Pi coding session owns its model, tools and approvals. Voice does not grant approval. Wait for that request's final result before delegating another request. Text beginning with "Agent Final Message" is the final answer from the coding session. Present its useful result naturally. For ordinary conversation needing no tools, respond directly.`;

export function registerPiLive(
  pi: ExtensionAPI,
  dependencies: LiveDependencies,
): LiveLifecycleBinding {
  let ctx: ExtensionContext | undefined;
  let retired = false;
  let controlVersion = 0;
  let preparing = false;
  let widgetVisible = false;
  let level = 0;
  let transcripts: Partial<Record<"user" | "assistant", string>> = {};
  let activeSignal: AbortSignal | undefined;
  const resources = new WeakMap<AbortSignal, LiveResources>();
  const host = dependencies.runtime?.executionHost ?? hostname;

  const paint = (): void => {
    if (!ctx || ctx.mode !== "tui" || retired) return;
    const state = binding.lifecycle.snapshot();
    if (["off", "stopping", "releasing", "blocked"].includes(state.state)) {
      if (widgetVisible) clearPresentation(ctx);
      widgetVisible = false;
      return;
    }
    const phase =
      state.state === "active"
        ? state.muted
          ? "muted"
          : binding.delegation.working()
            ? "working"
            : "listening"
        : state.state;
    const wave =
      state.state === "active" && !state.muted
        ? "▁▂▃▄▅▆▇█"[Math.min(7, Math.floor(level * 8))]!.repeat(8)
        : "--------";
    const lines = [
      `Pi Live: ${phase}${state.muted && binding.delegation.working() ? " / working" : ""} | ${wave} | ${state.voice}`,
      ...(transcripts.user ? [`You: ${transcripts.user}`] : []),
      ...(transcripts.assistant ? [`Voice: ${transcripts.assistant}`] : []),
    ];
    ctx.ui.setWidget(WIDGET_KEY, () => ({
      render: (width: number) =>
        lines.map((line) => fitLine(line, width, dependencies.truncateToWidth)),
      invalidate: () => undefined,
    }));
    widgetVisible = true;
  };
  const getResources = (signal: AbortSignal): LiveResources => {
    const resource = resources.get(signal);
    if (!resource) throw fixedRuntimeError("cancelled");
    return resource;
  };
  const binding = bindPiLiveLifecycle(pi, {
    facts: {
      async check(current) {
        ctx = current;
        return {
          compatible: (await dependencies.compatibility.check()).supported,
          configuredPackageSources:
            dependencies.runtime?.configuredPackageSources ??
            (await dependencies.packageSources?.(current)),
        };
      },
    },
    consent: {
      async request(input) {
        activeSignal = input.signal;
        transcripts = {};
        level = 0;
        paint();
        input.signal.addEventListener(
          "abort",
          () => {
            if (activeSignal !== input.signal) return;
            activeSignal = undefined;
            transcripts = {};
            level = 0;
            paint();
            const failure = binding.lifecycle.snapshot().lastFailure;
            if (!retired && failure && ctx?.mode === "tui")
              ctx.ui.notify(
                `Pi Live: ${runtimeDiagnosticText(failure)} Coding output remains in Pi.`,
                "warning",
              );
          },
          { once: true },
        );
        return input.openConfirm(
          "Start Pi Live voice?",
          `Execution host: ${host()}\n${LIVE_DISCLOSURE}`,
        );
      },
    },
    lifecycle: {
      ...dependencies.runtime?.lifecycle,
      resources: {
        credentials(input) {
          if (!ctx || input.signal.aborted)
            throw fixedRuntimeError("cancelled");
          paint();
          const callbacks: NonNullable<
            LiveRuntimeResourcesOptions["callbacks"]
          > = {
            onRequest(request) {
              if (input.signal.aborted || activeSignal !== input.signal)
                return false;
              const admitted = binding.delegation.request(request);
              paint();
              return admitted;
            },
            onTranscript(transcript) {
              if (input.signal.aborted || activeSignal !== input.signal) return;
              transcripts[transcript.role] = utf8Tail(
                transcript.text,
                LIVE_LIMITS.textBytes,
              );
              paint();
            },
            onLevel(value) {
              if (input.signal.aborted || activeSignal !== input.signal) return;
              level = value;
              paint();
            },
          };
          const resource = (
            dependencies.runtime?.resources ?? createLiveRuntimeResources
          )({
            registry: ctx.modelRegistry,
            sessionId: ctx.sessionManager.getSessionId(),
            instructions: LIVE_INSTRUCTIONS,
            clock: dependencies.runtime?.lifecycle?.clock,
            callbacks,
          });
          resources.set(input.signal, resource);
          return resource.credentials(input);
        },
        attestation: (input) => getResources(input.signal).attestation(input),
        connect(input) {
          paint();
          return getResources(input.signal).connect(input);
        },
      },
    },
  });

  const usage =
    "Usage: /live [start|stop|mute|unmute|voice <name>|status|help]";
  const handleTui = async (
    command: string,
    current: ExtensionContext,
  ): Promise<void> => {
    ctx = current;
    binding.enter(current);
    const lifecycle = binding.lifecycle;
    if (command === "help") {
      current.ui.notify(
        `Execution host: ${host()}. ${LIVE_DISCLOSURE} Controls: /live, start, stop, mute, unmute, voice <name>, status, help; Ctrl+Shift+L uses the same toggle. Use commands if shifted keys are unsupported. Do not load another live extension alongside Pi Live; known-source checks cannot inventory every extension.`,
        "info",
      );
      return;
    }
    if (command === "status") {
      const preferences = await dependencies.preferences.load();
      const compatibility = await dependencies.compatibility.check();
      const state = lifecycle.snapshot();
      current.ui.notify(
        `Pi Live: ${state.state}; ${state.muted ? "muted" : "unmuted"}; voice ${state.state === "off" ? preferences.voice : state.voice}; compatibility ${compatibilityText(compatibility)}${state.lastFailure ? `; ${state.lastFailure}` : ""}.`,
        "info",
      );
      return;
    }
    if (command.startsWith("voice ")) {
      const selected = command.slice(6).trim();
      if (!isLiveVoice(selected)) {
        current.ui.notify(
          `Unknown Pi Live voice. Available: ${LIVE_VOICE_VALUES.join(", ")}.`,
          "error",
        );
        return;
      }
      if (preparing || lifecycle.snapshot().state !== "off") {
        current.ui.notify(
          "Pi Live: stop voice before changing its voice preference.",
          "warning",
        );
        return;
      }
      await dependencies.preferences.setVoice(selected);
      await lifecycle.selectVoice(selected);
      current.ui.notify(
        `Pi Live voice set to ${selected} for the next call.`,
        "info",
      );
      return;
    }
    if (command === "stop" || (command === "" && preparing)) {
      ++controlVersion;
      preparing = false;
      await lifecycle.stop();
      paint();
      current.ui.notify(`Pi Live: ${lifecycle.snapshot().state}.`, "info");
      return;
    }
    if (command === "mute" || command === "unmute") {
      const result = await lifecycle.setMuted(command === "mute");
      paint();
      current.ui.notify(
        `Pi Live: ${result.state}${"muted" in result ? (result.muted ? "; muted" : "; unmuted") : `; ${command} unavailable`}.`,
        result.kind === "refused" ? "warning" : "info",
      );
      return;
    }
    if (command !== "" && command !== "start") {
      current.ui.notify(usage, "error");
      return;
    }
    if (preparing) {
      current.ui.notify("Pi Live: preparing.", "info");
      return;
    }
    if (lifecycle.snapshot().state === "off") {
      const version = ++controlVersion;
      preparing = true;
      try {
        const preferences = await dependencies.preferences.load();
        if (version !== controlVersion || retired) return;
        const compatibility = await dependencies.compatibility.check();
        if (version !== controlVersion || retired) return;
        if (!compatibility.supported) {
          current.ui.notify(
            `Pi Live: ${compatibilityText(compatibility)}.`,
            "warning",
          );
          return;
        }
        await lifecycle.selectVoice(preferences.voice);
      } finally {
        if (version === controlVersion) preparing = false;
      }
      if (version !== controlVersion || retired) return;
    }
    const result =
      command === "" ? await lifecycle.toggle() : await lifecycle.start();
    paint();
    const state = lifecycle.snapshot();
    if ("kind" in result && result.kind === "refused")
      current.ui.notify(
        `Pi Live: ${state.state}; ${result.diagnostic}.`,
        "warning",
      );
    else if (state.state !== "active")
      current.ui.notify(
        `Pi Live: ${state.state}${state.lastFailure ? `; ${state.lastFailure}` : ""}.`,
        "info",
      );
  };
  const handle = async (
    args: string,
    current: ExtensionContext,
  ): Promise<void> => {
    if (current.mode !== "tui") {
      current.ui.notify("Pi Live requires interactive TUI mode.", "warning");
      return;
    }
    if (retired) return;
    try {
      await handleTui(args.trim(), current);
    } catch (error) {
      if (error instanceof PreferenceError) {
        const description =
          error.code === "malformed"
            ? "is malformed"
            : error.code === "invalid-voice"
              ? "selects an invalid voice"
              : "could not be accessed or written";
        current.ui.notify(`Pi Live preference ${description}.`, "error");
      } else {
        await binding.lifecycle.interrupt("failure");
        current.ui.notify("Pi Live: protocol-error.", "error");
      }
      paint();
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
    description: "Control Pi Live voice",
    handler: handle,
  });
  pi.registerShortcut("ctrl+shift+l", {
    description: "Toggle Pi Live voice",
    handler: (current) => handle("", current),
  });
  pi.on("agent_settled", () => paint());
  pi.on("session_shutdown", (_event, current) => {
    retired = true;
    ++controlVersion;
    preparing = false;
    clearPresentation(current);
    widgetVisible = false;
    transcripts = {};
  });
  return binding;
}

// --- Public Pi lifecycle/conflict binding ---

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
  delegation: {
    request(request: { id: string; text: string }): boolean;
    working(): boolean;
  };
  enter(ctx: ExtensionContext): void;
}

/** Transport owns wire validation/replay; this adapter owns Pi result eligibility. */
function bindPiLiveDelegation(
  pi: ExtensionAPI,
  lifecycle: LiveLifecycle,
  clock: LiveClock,
) {
  type Message = MessageEndEvent["message"];
  type Receipt = {
    version: 1;
    source: "pi-live";
    generation: string;
    delegationId: string;
    receipt: string;
  };
  interface Call {
    generation: string;
    ctx: ExtensionContext;
    signal: AbortSignal;
    session: string;
    leaf: string | null;
  }
  interface Pending {
    call: Call;
    details: Receipt;
    content: string;
    before: Set<string>;
    branch: string[];
    starts: number;
    ends: number;
    runs: number;
    final?: { fingerprint: string; text: string };
    observed: Set<string>;
    completed: boolean;
    timer?: LiveTimer;
    deadline: number;
    send: LiveOutgoingSender;
    settle(): void;
  }
  let call: Call | undefined;
  let pending: Pending | undefined;
  const fingerprint = (message: Message): string =>
    createHash("sha256").update(JSON.stringify(message)).digest("hex");
  const clear = (): void => {
    const old = pending;
    pending = undefined;
    if (old?.timer) clock.clearTimer(old.timer);
    old?.settle();
  };
  const refuse = (): void => {
    // Fence first; no Pi abort, queue, steering or retry operation is used here.
    void lifecycle.interrupt("failure");
    clear();
  };
  function matches(
    value: {
      customType: string;
      content: unknown;
      display: boolean;
      details?: unknown;
    },
    a: Pending,
  ): boolean {
    const details = value.details;
    return (
      value.customType === DELEGATION_MESSAGE_TYPE &&
      value.content === a.content &&
      value.display === true &&
      isUnknownRecord(details) &&
      details.version === 1 &&
      details.source === "pi-live" &&
      details.generation === a.details.generation &&
      details.delegationId === a.details.delegationId &&
      details.receipt === a.details.receipt &&
      Object.keys(details).length === 5
    );
  }
  function newBranch(
    a: Pending,
    ctx: ExtensionContext,
  ): SessionEntry[] | undefined {
    const manager = ctx.sessionManager;
    if (manager.getSessionId() !== a.call.session) return;
    const branch = manager.getBranch();
    if (a.branch.some((id, i) => branch[i]?.id !== id)) return;
    const newer = branch.slice(a.branch.length);
    if (newer.some((e) => a.before.has(e.id))) return;
    // New off-branch entries mean a movement or competing append occurred.
    const branchIds = new Set(newer.map((e) => e.id));
    if (
      manager
        .getEntries()
        .some((e) => !a.before.has(e.id) && !branchIds.has(e.id))
    )
      return;
    return newer;
  }
  function receiptPresent(a: Pending, ctx: ExtensionContext): boolean {
    const entries = newBranch(a, ctx);
    return (
      entries !== undefined &&
      entries.filter((e) => e.type === "custom_message" && matches(e, a))
        .length === 1
    );
  }
  function checkReceipt(a: Pending): void {
    if (pending !== a) return;
    if (clock.now() >= a.deadline || !receiptPresent(a, a.call.ctx)) {
      refuse();
      return;
    }
    if (a.timer) clock.clearTimer(a.timer);
    a.timer = undefined;
  }
  pi.on("agent_start", () => {
    if (pending && ++pending.runs !== 1) refuse();
  });
  pi.on("input", () => {
    if (pending) refuse();
  });
  pi.on("message_start", (event) => {
    const a = pending;
    if (!a) return;
    const m = event.message;
    if (m.role === "custom" && matches(m, a)) {
      if (++a.starts !== 1 || a.ends !== 0 || clock.now() >= a.deadline)
        refuse();
    } else if (
      m.role === "user" ||
      m.role === "custom" ||
      (m.role !== "system" && (a.starts !== 1 || a.ends !== 1))
    )
      refuse();
  });
  pi.on("message_end", (event) => {
    const a = pending;
    if (!a) return;
    const m = event.message;
    if (m.role === "custom" && matches(m, a)) {
      if (a.starts !== 1 || ++a.ends !== 1 || clock.now() >= a.deadline)
        refuse();
      return;
    }
    if (m.role === "user" || m.role === "custom") {
      refuse();
      return;
    }
    if (m.role === "assistant") {
      if (
        a.starts !== 1 ||
        a.ends !== 1 ||
        (m.stopReason !== "stop" && m.stopReason !== "toolUse")
      ) {
        refuse();
        return;
      }
      if (m.stopReason === "stop") {
        if (a.final) {
          refuse();
          return;
        }
        // Retain bounded final text and fingerprints, never raw tool output or
        // thinking. One extra byte is enough to select the truncation marker.
        let text = "";
        for (const block of m.content) {
          if (block.type !== "text") continue;
          if (text) text += "\n";
          const remaining = LIVE_LIMITS.textBytes + 4 - Buffer.byteLength(text);
          text += utf8Prefix(block.text, Math.max(0, remaining));
          if (Buffer.byteLength(text) > LIVE_LIMITS.textBytes) break;
        }
        a.final = {
          fingerprint: fingerprint(m),
          text: truncateLiveFinal(text),
        };
      }
    } else if (m.role !== "system" && m.role !== "toolResult") {
      refuse();
      return;
    }
    a.observed.add(fingerprint(m));
  });
  // message_end fires before persistence. The next public turn/context boundary
  // observes the actual stored receipt instead of predicting its entry ID.
  pi.on("context", (_event, ctx) => {
    const a = pending;
    if (a && a.timer) {
      if (receiptPresent(a, ctx)) checkReceipt(a);
      else refuse();
    }
  });
  pi.on("context_with_system", (event, ctx) => {
    if (!pending) return;
    // This event runs after all ordinary context handlers. Pi-owned system
    // deltas may change; altered model-visible user/custom/tool history may not.
    const actual = event.messages
      .filter((m) => m.role !== "system")
      .map(fingerprint);
    const expected = ctx.sessionManager
      .buildSessionProjection()
      .messages.filter((m) => m.role !== "system")
      .map(fingerprint);
    if (
      actual.length !== expected.length ||
      actual.some((value, i) => value !== expected[i])
    )
      refuse();
  });
  pi.on("turn_end", (event, ctx) => {
    const a = pending;
    if (!a) return;
    if (
      event.outcome !== "completed" ||
      event.continue ||
      event.entries.some((e) => e.type !== "custom") ||
      event.context.pendingMessages.length > 0
    ) {
      refuse();
      return;
    }
    if (a.timer) checkReceipt(a);
    if (!newBranch(a, ctx)) refuse();
  });
  pi.on("agent_before_settle", (event) => {
    if (!pending) return;
    if (
      event.outcome !== "completed" ||
      event.continue ||
      event.entries.some((e) => e.type !== "custom") ||
      event.context.pendingMessages.length > 0
    )
      refuse();
    else pending.completed = true;
  });
  pi.on("agent_settled", (_event, ctx) => {
    const a = pending;
    if (!a) return;
    const entries = newBranch(a, ctx);
    const receipts =
      entries?.filter((e) => e.type === "custom_message" && matches(e, a)) ??
      [];
    const final = a.final;
    const finalIndex =
      entries?.findIndex(
        (e) =>
          e.type === "message" && fingerprint(e.message) === final?.fingerprint,
      ) ?? -1;
    const receiptIndex =
      entries?.findIndex((e) => e.id === receipts[0]?.id) ?? -1;
    const projected = ctx.sessionManager
      .buildSessionProjection()
      .entries.filter((e) => e.sourceEntry.id === receipts[0]?.id);
    const valid =
      call === a.call &&
      !a.call.signal.aborted &&
      lifecycle.snapshot().state === "active" &&
      a.starts === 1 &&
      a.ends === 1 &&
      a.runs === 1 &&
      a.completed &&
      !ctx.hasPendingMessages() &&
      receipts.length === 1 &&
      entries !== undefined &&
      finalIndex > receiptIndex &&
      entries.every((e) => {
        if (e.type === "custom_message") return matches(e, a);
        if (e.type === "message") return a.observed.has(fingerprint(e.message));
        return (
          e.type === "custom" ||
          e.type === "label" ||
          e.type === "session_info" ||
          e.type === "usage"
        );
      }) &&
      projected.length === 1 &&
      projected[0]?.messages.length === 1 &&
      projected[0].messages[0]?.role === "custom" &&
      matches(projected[0].messages[0], a) &&
      final !== undefined;
    const text = final?.text ?? "";
    if (!valid || !text.trim() || !isValidUtf8String(text)) {
      refuse();
      return;
    }
    clear();
    a.call.leaf = ctx.sessionManager.getLeafId();
    a.send({ kind: "final", text: truncateLiveFinal(text) });
  });
  const invalidate = (): void => {
    if (pending) refuse();
  };
  pi.on("session_before_compact", invalidate);
  pi.on("session_compact", invalidate);
  pi.on("session_compact_failed", invalidate);
  pi.on("session_before_tree", invalidate);
  pi.on("session_tree", invalidate);
  pi.on("session_before_switch", invalidate);
  pi.on("session_before_fork", invalidate);
  pi.on("session_shutdown", invalidate);
  pi.on("session_start", invalidate);
  return {
    begin(
      generation: string,
      ctx: ExtensionContext,
      signal: AbortSignal,
    ): void {
      clear();
      const current: Call = {
        generation,
        ctx,
        signal,
        session: ctx.sessionManager.getSessionId(),
        leaf: ctx.sessionManager.getLeafId(),
      };
      call = current;
      signal.addEventListener(
        "abort",
        () => {
          if (call !== current) return;
          call = undefined;
          clear();
        },
        { once: true },
      );
    },
    working: () => pending !== undefined,
    request(request: { id: string; text: string }): boolean {
      const current = call;
      const ctx = current?.ctx;
      if (
        !current ||
        !ctx ||
        current.signal.aborted ||
        pending ||
        lifecycle.snapshot().state !== "active" ||
        !validCredentialField(request.id, LIVE_LIMITS.idBytes) ||
        !byteLengthWithin(request.text, LIVE_LIMITS.textBytes) ||
        !isValidUtf8String(request.text) ||
        !request.text.trim() ||
        !ctx.isIdle() ||
        ctx.hasPendingMessages() ||
        ctx.signal ||
        ctx.sessionManager.getSessionId() !== current.session ||
        ctx.sessionManager.getLeafId() !== current.leaf
      ) {
        refuse();
        return false;
      }
      const admission = lifecycle.delegationAdmitted();
      const send = lifecycle.createOutgoingSender();
      if (admission.kind !== "updated" || !send) {
        refuse();
        return false;
      }
      const a: Pending = {
        call: current,
        details: {
          version: 1,
          source: "pi-live",
          generation: current.generation,
          delegationId: request.id,
          receipt: randomUUID(),
        },
        content: `[Voice coding request]\n${request.text}`,
        before: new Set(ctx.sessionManager.getEntries().map((e) => e.id)),
        branch: ctx.sessionManager.getBranch().map((e) => e.id),
        starts: 0,
        ends: 0,
        runs: 0,
        observed: new Set(),
        completed: false,
        deadline: clock.now() + 5_000,
        send,
        settle: admission.settle,
      };
      pending = a;
      a.timer = clock.setTimer(() => {
        if (pending === a) refuse();
      }, 5_000);
      try {
        pi.sendMessage(
          {
            customType: DELEGATION_MESSAGE_TYPE,
            content: a.content,
            display: true,
            details: a.details,
          },
          { triggerTurn: true },
        );
      } catch {
        refuse();
        return false;
      }
      return true;
    },
  };
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
          if (accepted) delegation.begin(input.generation, ctx, input.signal);
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

  // Lifecycle handlers must fence synchronously before any other handler can
  // yield through Pi's sequential event dispatcher.
  const delegation = bindPiLiveDelegation(
    pi,
    lifecycle,
    options.lifecycle?.clock ?? defaultClock(),
  );
  return {
    lifecycle,
    delegation,
    enter: (ctx) => {
      // Pi shortcuts receive an unwrapped UI. Keep the session-event context so
      // our own consent still uses Pi's reported confirm primitive.
      currentContext ??= ctx;
    },
  };
}
