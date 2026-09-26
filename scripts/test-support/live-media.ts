import {
  createLiveRuntimeResources,
  type LiveRuntimeResourcesOptions,
  type LiveSidebandStartInput,
  type LiveNativeAdapter,
} from "../../src/live.ts";
import { settledStart, createFakeCapture } from "./live-fixture.ts";

/** Real parser/writer with deterministic native/network boundaries. */
export function fakeMedia() {
  const frames: string[] = [];
  let sideband: LiveSidebandStartInput | undefined;
  let dataChannel: ((payload: string) => void) | undefined;
  let sample: ((samples: Float32Array) => void) | undefined;
  let resourcesCreated = 0;
  let captured = 0;
  let stopped = 0;
  const native: LiveNativeAdapter = {
    createPeer(input) {
      dataChannel = input.onEvent;
      return settledStart({
        createOffer: async () => "fake-offer",
        acceptAnswer: async () => undefined,
        waitForOpen: async () => undefined,
        pushAudio: () => {
          captured++;
        },
        setMuted: () => undefined,
        close: async () => true,
      });
    },
    startCapture(input) {
      sample = input.onSample;
      return settledStart(
        createFakeCapture({
          stop: async () => {
            stopped++;
          },
        }),
      );
    },
  };
  const appended = (type: string) =>
    frames
      .map((frame) => JSON.parse(frame) as Record<string, unknown>)
      .filter((frame) => frame.type === type);
  return {
    frames,
    /** Pi's replies sent for speech. */
    finals: () => appended("session.commentary.append"),
    /** Quiet progress context. */
    progress: () => appended("session.thinking.append"),
    counts: () => ({ resourcesCreated, captured, stopped }),
    emit(value: unknown) {
      dataChannel?.(JSON.stringify(value));
    },
    emitSideband(value: unknown) {
      sideband?.onText(Buffer.from(JSON.stringify(value)));
    },
    request(id: string, text: string) {
      dataChannel?.(
        JSON.stringify({
          type: "session.input_transcript.delta",
          delta: text,
          start_ms: 0,
          end_ms: 1,
        }),
      );
      dataChannel?.(
        JSON.stringify({
          type: "session.delegation.created",
          offset_ms: 1,
          delegation: { id, type: "delegation", target: "client" },
        }),
      );
    },
    sample() {
      sample?.(new Float32Array([0.25, 0.5]));
    },
    resources(options: LiveRuntimeResourcesOptions) {
      resourcesCreated++;
      return createLiveRuntimeResources({
        ...options,
        registry: {
          getApiKeyForProvider: async () => "sk-synthetic-fixture",
        },
        native,
        proxyForUrl: () => undefined,
        network: {
          signal: () =>
            settledStart({
              status: 201,
              statusText: "Created",
              body: (async function* () {
                yield Buffer.from(
                  JSON.stringify({
                    session: { id: "live_fixture" },
                    transport: { type: "webrtc", sdp: "fake-answer" },
                  }),
                );
              })(),
              cancel() {},
            }),
          openSideband(input) {
            sideband = input;
            return settledStart({
              bufferedAmount: () => 0,
              sendText: async (text) => {
                frames.push(text);
              },
              sendPong: async () => undefined,
              close: async () => true,
            });
          },
        },
      });
    },
  };
}
