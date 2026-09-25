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
  let sample: ((samples: Float32Array) => void) | undefined;
  let resourcesCreated = 0;
  let captured = 0;
  let stopped = 0;
  const native: LiveNativeAdapter = {
    deviceCheck: {
      generateToken: async () => ({ supported: false, latencyMs: 0 }),
    },
    createPeer: () =>
      settledStart({
        createOffer: async () => "fake-offer",
        acceptAnswer: async () => undefined,
        waitForOpen: async () => undefined,
        pushAudio: () => {
          captured++;
        },
        setMuted: () => undefined,
        close: async () => true,
      }),
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
  return {
    frames,
    counts: () => ({ resourcesCreated, captured, stopped }),
    emit(value: unknown) {
      sideband?.onText(Buffer.from(JSON.stringify(value)));
    },
    request(id: string, text: string) {
      sideband?.onText(
        Buffer.from(
          JSON.stringify({
            type: "delegation.created",
            item: {
              type: "delegation",
              target: "client",
              id,
              content: [{ type: "input_text", text }],
            },
          }),
        ),
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
          getApiKeyForProvider: async () =>
            JSON.stringify({
              access: "synthetic-access",
              accountId: "fixture",
              expires: Date.now() + 60_000,
            }),
        },
        native,
        proxyForUrl: () => undefined,
        network: {
          signal: () =>
            settledStart({
              status: 200,
              statusText: "OK",
              location: "/v1/live/rtc_fixture",
              body: (async function* () {
                yield Buffer.from("fake-answer");
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
