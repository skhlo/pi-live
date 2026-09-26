// Browser mode sends one-step voice requests to a separately running
// voice-browser controller (github.com/moritzkremb/jev-voice-browser) over its
// loopback WebSocket. The controller owns page observation, Jev's decision and
// Playwright execution; this client turns its broadcast events into one
// outcome per request. It never retries or rolls back browser actions.
// A router asks Jev beforehand whether a request is one browser step or a
// task for Pi.

export const DEFAULT_BROWSER_URL = "ws://127.0.0.1:8787";
const RESULT_TIMEOUT_MS = 20_000;
const PAGE_SETTLE_MS = 3_000;
const LABEL_CHARS = 200;

export interface BrowserPage {
  url: string;
  title: string;
}

export interface BrowserOutcome {
  /** What happened, phrased for the voice model or, when handed off, for Pi. */
  text: string;
  /** The controller refused or failed in a way Pi may handle instead. */
  handOff: boolean;
}

export interface BrowserController {
  /** Resolves with the outcome, or undefined when aborted. */
  run(
    id: string,
    command: string,
    signal: AbortSignal,
  ): Promise<BrowserOutcome | undefined>;
  /** The page the controller last reported, if any. */
  page(): BrowserPage | undefined;
}

/** One fast browser step, several steps of web work, or anything else for Pi. */
export type BrowserRoute = "browser" | "browser_task" | "pi";

export interface BrowserRouter {
  /** Resolves undefined when the router cannot decide. */
  route(
    request: string,
    page: BrowserPage | undefined,
    signal: AbortSignal,
  ): Promise<BrowserRoute | undefined>;
}

export interface BrowserSocket {
  send(text: string): void;
  close(): void;
}

export interface BrowserSocketEvents {
  onOpen(): void;
  onText(text: string): void;
  onClose(): void;
}

export type BrowserSocketFactory = (
  url: string,
  events: BrowserSocketEvents,
) => BrowserSocket;

/** Returns the controller URL when it is a plain ws:// loopback address. */
export function browserControllerUrl(
  value: string | undefined,
): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value?.trim() || DEFAULT_BROWSER_URL);
  } catch {
    return undefined;
  }
  if (
    parsed.protocol !== "ws:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
    parsed.username ||
    parsed.password
  )
    return undefined;
  return parsed.href.replace(/\/$/, "");
}

// Node's built-in WebSocket keeps the module free of eager network imports.
function nodeSocket(url: string, events: BrowserSocketEvents): BrowserSocket {
  const socket = new WebSocket(url);
  socket.addEventListener("open", () => events.onOpen());
  socket.addEventListener("message", (event) => {
    if (typeof event.data === "string") events.onText(event.data);
  });
  socket.addEventListener("close", () => events.onClose());
  return {
    send: (text) => socket.send(text),
    close: () => socket.close(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, LABEL_CHARS)
    : "";
}

function actionLabel(action: unknown): string {
  if (!isRecord(action)) return "the action";
  return (
    text(action.label) ||
    text(action.url) ||
    text(action.type).replace(/_/g, " ") ||
    "the action"
  );
}

function observedPage(snapshot: unknown): BrowserPage | undefined {
  if (!isRecord(snapshot)) return undefined;
  const url = text(snapshot.url);
  return url ? { url, title: text(snapshot.title) } : undefined;
}

export function describePage(page: BrowserPage | undefined): string {
  if (!page) return "";
  return page.title ? `"${page.title}" (${page.url})` : page.url;
}

export function createBrowserController(
  url: string,
  options: {
    socket?: BrowserSocketFactory;
    timeoutMs?: number;
    settleMs?: number;
  } = {},
): BrowserController {
  const createSocket = options.socket ?? nodeSocket;
  const timeoutMs = options.timeoutMs ?? RESULT_TIMEOUT_MS;
  const settleMs = options.settleMs ?? PAGE_SETTLE_MS;
  let lastPage: BrowserPage | undefined;
  return {
    page: () => lastPage,
    run(id, command, signal) {
      return new Promise((resolve) => {
        const utteranceId = `pi-live-${id}`;
        let socket: BrowserSocket | undefined;
        let opened = false;
        let registered = false;
        let waits = 0;
        let action: { label: string; ok: boolean; detail: string } | undefined;
        let settle: ReturnType<typeof setTimeout> | undefined;
        let done = false;

        const finish = (
          outcome: BrowserOutcome | undefined,
          release = false,
        ): void => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          clearTimeout(settle);
          signal.removeEventListener("abort", abort);
          // An empty utterance replaces ours, so the controller stops
          // re-asking Jev about a command it could not complete.
          if (release && opened)
            try {
              socket?.send(
                JSON.stringify({
                  type: "transcript",
                  text: "",
                  final: true,
                  utteranceId: `${utteranceId}-end`,
                }),
              );
            } catch {
              // The controller already went away.
            }
          socket?.close();
          resolve(outcome);
        };
        const abort = (): void => finish(undefined);
        const said = (text: string): BrowserOutcome => ({
          text,
          handOff: false,
        });
        const actionOutcome = (): void => {
          if (!action) return;
          const page = describePage(lastPage);
          finish(
            action.ok
              ? said(
                  `Done: ${action.label}.${page ? ` The page is now ${page}.` : ""}`,
                )
              : {
                  text: `the browser controller tried to ${action.label} and failed: ${action.detail || "no detail"}`,
                  handOff: true,
                },
          );
        };
        const timer = setTimeout(
          () =>
            action
              ? actionOutcome()
              : finish(
                  said(
                    `No browser outcome within ${Math.round(timeoutMs / 1_000)} seconds; the browser may still act.`,
                  ),
                  true,
                ),
          timeoutMs,
        );
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) return abort();

        const onEvent = (type: string, payload: unknown): void => {
          if (type === "hello" || type === "snapshot") {
            const page = observedPage(
              type === "hello" && isRecord(payload)
                ? payload.snapshot
                : payload,
            );
            if (page) lastPage = page;
          }
          if (type === "transcript") {
            if (isRecord(payload) && payload.utteranceId === utteranceId)
              registered = true;
            return;
          }
          if (!registered) return;
          if (type === "snapshot") {
            if (action) actionOutcome();
            return;
          }
          if (type === "action" && isRecord(payload)) {
            action = {
              label: actionLabel(payload.action),
              ok: payload.ok === true,
              detail: text(payload.detail),
            };
            if (!action.ok) return actionOutcome();
            // The page snapshot refreshes right after the action.
            settle = setTimeout(() => actionOutcome(), settleMs);
            return;
          }
          if (type === "log" && isRecord(payload) && payload.level === "error")
            return finish({
              text: `the browser controller reported an error: ${text(payload.msg)}`,
              handOff: true,
            });
          if (type === "candidates" && Array.isArray(payload)) {
            const choices = payload
              .filter(isRecord)
              .map((choice, index) => `${index + 1}. ${text(choice.label)}`)
              .join("; ");
            return finish(
              said(
                `Not done yet: more than one match. Ask which one: ${choices}. The user can answer with the number.`,
              ),
            );
          }
          if (type !== "decision" || !isRecord(payload)) return;
          const policy = isRecord(payload.policy) ? payload.policy : {};
          const summary = text(policy.summary);
          switch (policy.decision) {
            case "confirm":
              return finish(
                said(
                  `Not done yet: it needs confirmation first (${summary}). The user can say "confirm" or "cancel".`,
                ),
              );
            case "cancel":
              return finish(said("Cancelled the pending browser action."));
            case "ignore":
              return finish({
                text: `the browser controller did not recognize a browser command (${summary})`,
                handOff: true,
              });
            case "wait":
              // A first wait can still resolve once the words settle; a
              // repeated one means the controller cannot complete it.
              if (++waits >= 2)
                finish(
                  {
                    text: `the browser controller could not complete the command (${summary || "unclear"})`,
                    handOff: true,
                  },
                  true,
                );
              return;
            default:
              return;
          }
        };

        try {
          socket = createSocket(url, {
            onOpen() {
              opened = true;
              if (done) return;
              socket?.send(
                JSON.stringify({
                  type: "transcript",
                  text: command,
                  final: true,
                  utteranceId,
                }),
              );
            },
            onText(raw) {
              if (done) return;
              let message: unknown;
              try {
                message = JSON.parse(raw);
              } catch {
                return;
              }
              if (isRecord(message) && typeof message.type === "string")
                onEvent(message.type, message.payload);
            },
            onClose() {
              if (action) return actionOutcome();
              finish(
                said(
                  opened
                    ? "The browser controller disconnected before reporting an outcome."
                    : `The browser controller is not reachable at ${url}. Start voice-browser first.`,
                ),
              );
            },
          });
        } catch {
          finish(
            said(
              `The browser controller is not reachable at ${url}. Start voice-browser first.`,
            ),
          );
        }
      });
    },
  };
}

const ROUTER_URL = "https://api.typesafe.ai/v1/systemone";
const ROUTER_TIMEOUT_MS = 3_000;

/** One Jev choice per request: a single browser step, multi-step web work, or other work for Pi. */
export function createBrowserRouter(
  apiKey: string,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): BrowserRouter {
  const request = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? ROUTER_TIMEOUT_MS;
  return {
    async route(spoken, page, signal) {
      const timeout = AbortSignal.timeout(timeoutMs);
      try {
        const response = await request(ROUTER_URL, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "jev-latest",
            state: {
              request: spoken.slice(0, 2_000),
              current_page: page ?? null,
            },
            questions: {
              route: {
                type: "choice",
                instructions:
                  "The user spoke `request` to a voice assistant that controls the web browser showing `current_page` and also works with a coding agent. Which kind of work is `request`?",
                criteria: {
                  browser_step:
                    "Exactly one immediate browser action fully satisfies it: open a named site or address, search for given words, click or open a named link, heading, button, article or item on the current page, scroll, type given text, go back or forward, switch tabs, confirm or cancel, pick a numbered choice, or correct the last action such as 'no, the other one'.",
                  browser_task:
                    "Web work needing more than one browser action or a judgment: several steps in sequence, finding, comparing or choosing (the cheapest, all models, listings in a country), reading, summarizing or extracting page content, filling a form, signing in, or opening a new tab and then doing something there.",
                  other:
                    "Not web browsing: coding, repository, file, terminal, test or general questions for the coding agent.",
                },
              },
            },
          }),
          signal: AbortSignal.any([signal, timeout]),
        });
        if (!response.ok) return undefined;
        const body: unknown = await response.json();
        const answers = isRecord(body) ? body.answers : undefined;
        const route = isRecord(answers) ? answers.route : undefined;
        const picked = isRecord(route) ? route.choice : undefined;
        return picked === "browser_step"
          ? "browser"
          : picked === "browser_task"
            ? "browser_task"
            : picked === "other"
              ? "pi"
              : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

/** Returns the DevTools endpoint when it is a plain http:// loopback address. */
export function browserDevToolsUrl(
  value: string | undefined,
): string | undefined {
  if (!value?.trim()) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (
    parsed.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
    parsed.username ||
    parsed.password
  )
    return undefined;
  return parsed.href.replace(/\/$/, "");
}
