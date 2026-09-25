import assert from "node:assert/strict";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

type Stream = ReturnType<ModelRuntime["streamSimple"]>;
type Message = Awaited<ReturnType<Stream["result"]>>;

// Resolve the pinned SDK's own stream implementation for this provider fixture.
// Production code never imports an undeclared Pi dependency.
const ai: unknown = await import(
  new URL(
    "../../pi-ai/dist/index.js",
    import.meta.resolve("@earendil-works/pi-coding-agent"),
  ).href
);
assert.ok(
  ai && typeof ai === "object" && "createAssistantMessageEventStream" in ai,
);
assert.equal(typeof ai.createAssistantMessageEventStream, "function");
const createStream = ai.createAssistantMessageEventStream as () => Stream;

export function fakeProvider(
  options: {
    hold?: Promise<void>;
    error?: boolean;
    tool?: boolean;
    final?: string;
    retry?: boolean;
  } = {},
) {
  let calls = 0;
  const provider: Parameters<ModelRuntime["registerProvider"]>[1] = {
    api: "live-fixture-api",
    apiKey: "synthetic-fixture-key",
    baseUrl: "https://invalid.invalid",
    models: [
      {
        id: "fixture",
        name: "Offline fixture",
        reasoning: false,
        input: ["text"],
        contextWindow: 8000,
        maxTokens: 1000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    streamSimple(model, _context, input) {
      const stream = createStream();
      const call = ++calls;
      void (async () => {
        let abort: (() => void) | undefined;
        try {
          if (options.hold && call === 1)
            await Promise.race([
              options.hold,
              new Promise<void>((resolve) => {
                abort = () => resolve();
                if (input?.signal?.aborted) resolve();
                else
                  input?.signal?.addEventListener("abort", abort, {
                    once: true,
                  });
              }),
            ]);
          const reason = input?.signal?.aborted
            ? "aborted"
            : options.error || (options.retry && call === 1)
              ? "error"
              : options.tool && call === 1
                ? "toolUse"
                : "stop";
          const message: Message = {
            role: "assistant",
            provider: model.provider,
            model: model.id,
            api: model.api,
            timestamp: Date.now(),
            stopReason: reason,
            content:
              reason === "toolUse"
                ? [
                    { type: "text", text: "private intermediate commentary" },
                    { type: "thinking", thinking: "private thinking" },
                    {
                      type: "toolCall",
                      id: "fixture-tool",
                      name: "fixture_tool",
                      arguments: {},
                    },
                  ]
                : [
                    {
                      type: "text",
                      text: options.final ?? "Owned final result",
                    },
                  ],
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            ...(reason === "error"
              ? {
                  errorMessage: options.retry
                    ? "503 Service Unavailable"
                    : "synthetic private failure",
                }
              : {}),
          };
          if (reason === "error" || reason === "aborted")
            stream.push({ type: "error", reason, error: message });
          else {
            stream.push({
              type: "start",
              partial: { ...message, content: [], stopReason: "pending" },
            });
            stream.push({ type: "done", reason, message });
          }
        } finally {
          if (abort) input?.signal?.removeEventListener("abort", abort);
          stream.end();
        }
      })();
      return stream;
    },
  };
  return { provider, calls: () => calls };
}
