// Pi's browser tool for browser-mode calls. It drives the same Chrome as the
// voice-browser controller through its DevTools endpoint, so work handed to Pi
// continues on the page the user is looking at. Each action waits for the page
// to settle and returns a compact view of the result, so acting and checking
// take one call. It uses Node's built-in fetch and WebSocket only.

const COMMAND_TIMEOUT_MS = 10_000;
const SETTLE_MS = 8_000;
const READ_CHARS = 6_000;
const ELEMENTS = 40;

export const BROWSER_TOOL_ACTIONS = [
  "look",
  "open",
  "click",
  "type",
  "press",
  "scroll",
  "back",
  "read",
  "tabs",
  "switch_tab",
  "new_tab",
] as const;
export type BrowserToolAction = (typeof BROWSER_TOOL_ACTIONS)[number];

export interface BrowserToolParams {
  action: BrowserToolAction;
  url?: string;
  ref?: number;
  target?: string;
  text?: string;
  submit?: boolean;
  key?: string;
  direction?: "up" | "down" | "top" | "bottom";
  tab?: number;
  offset?: number;
}

export const BROWSER_TOOL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: {
      type: "string",
      enum: [...BROWSER_TOOL_ACTIONS],
      description:
        "look: show the current page. open: go to url in this tab. click: click an element by ref (from the last view) or by its visible text in target. type: type text into a field by ref or target (its label or placeholder), optionally submit. press: press key (Enter, Escape, Tab, ArrowDown...). scroll: direction. back: go back. read: page text from offset. tabs: list tabs. switch_tab: tab index. new_tab: open url in a new tab only when the user asks for one.",
    },
    url: { type: "string" },
    ref: { type: "integer", minimum: 1 },
    target: { type: "string" },
    text: { type: "string" },
    submit: { type: "boolean" },
    key: { type: "string" },
    direction: { type: "string", enum: ["up", "down", "top", "bottom"] },
    tab: { type: "integer", minimum: 0 },
    offset: { type: "integer", minimum: 0 },
  },
} as const;

interface PageTarget {
  id: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

export interface BrowserToolPage {
  url: string;
  title: string;
}

export interface BrowserToolResult {
  text: string;
  page?: BrowserToolPage;
}

interface Session {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function openSession(url: string, signal?: AbortSignal): Promise<Session> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map<
      number,
      { resolve(value: unknown): void; reject(error: Error): void }
    >();
    let next = 0;
    const fail = (error: Error): void => {
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
    };
    const abort = (): void => {
      socket.close();
      fail(new Error("cancelled"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    socket.addEventListener("error", () =>
      reject(new Error("DevTools connection failed")),
    );
    socket.addEventListener("close", () => {
      signal?.removeEventListener("abort", abort);
      fail(new Error("DevTools connection closed"));
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let message: unknown;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!isRecord(message) || typeof message.id !== "number") return;
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (isRecord(message.error))
        waiter.reject(new Error(String(message.error.message ?? "failed")));
      else waiter.resolve(message.result);
    });
    socket.addEventListener("open", () =>
      resolve({
        send(method, params = {}) {
          const id = ++next;
          return new Promise((resolveCommand, rejectCommand) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              rejectCommand(new Error(`${method} timed out`));
            }, COMMAND_TIMEOUT_MS);
            pending.set(id, {
              resolve: (value) => {
                clearTimeout(timer);
                resolveCommand(value);
              },
              reject: (error) => {
                clearTimeout(timer);
                rejectCommand(error);
              },
            });
            socket.send(JSON.stringify({ id, method, params }));
          });
        },
        close: () => socket.close(),
      }),
    );
  });
}

async function evaluate<T>(session: Session, expression: string): Promise<T> {
  const result = await session.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (isRecord(result) && isRecord(result.exceptionDetails))
    throw new Error("page script failed");
  const value =
    isRecord(result) && isRecord(result.result)
      ? result.result.value
      : undefined;
  return value as T;
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// In-page helpers shared by the scripts below. Refs are data attributes set by
// the last view, so a ref stays valid until the next view or navigation.
const PAGE_HELPERS = `
const SEL = 'a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=option],[role=combobox],[contenteditable=true],summary';
const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
const inView = (el) => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; };
const labelOf = (el) => clean(el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].innerText) || el.innerText || el.value || el.placeholder || el.title || el.getAttribute('alt') || el.name).slice(0, 80);
const roleOf = (el) => el.getAttribute('role') || (el.tagName === 'A' ? 'link' : el.tagName === 'INPUT' ? (el.type || 'text') : el.tagName.toLowerCase());
const find = (ref, target, fields) => {
  if (ref) { const el = document.querySelector('[data-pi-ref="' + ref + '"]'); if (el) return el; }
  if (!target) return null;
  const want = clean(target).toLowerCase();
  const pool = [...document.querySelectorAll(fields ? 'input:not([type=hidden]),textarea,select,[contenteditable=true],[role=combobox]' : SEL)].filter(visible);
  let best = null, bestScore = 0;
  for (const el of pool) {
    const names = [labelOf(el), clean(el.placeholder), clean(el.name), clean(el.getAttribute('aria-label'))].map((s) => s.toLowerCase()).filter(Boolean);
    let score = 0;
    for (const n of names) score = Math.max(score, n === want ? 4 : n.startsWith(want) ? 3 : n.includes(want) ? 2 : want.includes(n) && n.length > 2 ? 1 : 0);
    if (score && inView(el)) score += 0.5;
    if (score > bestScore) { best = el; bestScore = score; }
  }
  return best;
};`;

const VIEW_SCRIPT = `(() => {${PAGE_HELPERS}
  document.querySelectorAll('[data-pi-ref]').forEach((el) => el.removeAttribute('data-pi-ref'));
  // Unnamed controls other than fields, and repeats of the same control, only cost tokens.
  const items = []; const seen = new Set(); let n = 0;
  for (const el of document.querySelectorAll(SEL)) {
    if (!visible(el)) continue;
    const role = roleOf(el); const text = labelOf(el);
    const field = el.matches('input,textarea,select,[contenteditable=true],[role=combobox]');
    if (!text && !field) continue;
    if (seen.has(role + text)) continue;
    seen.add(role + text);
    const ref = ++n; el.setAttribute('data-pi-ref', String(ref));
    items.push({ ref, role, text, view: inView(el) });
  }
  items.sort((a, b) => Number(b.view) - Number(a.view));
  const shown = items.slice(0, ${ELEMENTS});
  const headings = [...document.querySelectorAll('h1,h2,h3')].filter(visible).map((h) => clean(h.innerText).slice(0, 60)).filter(Boolean).slice(0, 5);
  return { url: location.href, title: document.title, headings,
    elements: shown.map((i) => '[' + i.ref + '] ' + i.role + ' "' + i.text + '"' + (i.view ? '' : ' (below)')),
    more: items.length - shown.length, scrollY: Math.round(scrollY), height: Math.round(document.documentElement.scrollHeight) };
})()`;

const locateScript = (
  ref: number | undefined,
  target: string | undefined,
  fields: boolean,
): string => `(() => {${PAGE_HELPERS}
  const el = find(${JSON.stringify(ref ?? 0)}, ${JSON.stringify(target ?? "")}, ${fields});
  if (!el) return null;
  if (el.tagName === 'A' && el.target === '_blank') el.removeAttribute('target');
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  return { label: labelOf(el), x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`;

const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Escape: { code: "Escape", keyCode: 27 },
  Tab: { code: "Tab", keyCode: 9 },
  Backspace: { code: "Backspace", keyCode: 8 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  PageDown: { code: "PageDown", keyCode: 34 },
  PageUp: { code: "PageUp", keyCode: 33 },
};

async function pressKey(session: Session, key: string): Promise<boolean> {
  const spec = KEYS[key];
  if (!spec) return false;
  const base = {
    key,
    code: spec.code,
    windowsVirtualKeyCode: spec.keyCode,
    nativeVirtualKeyCode: spec.keyCode,
  };
  await session.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    ...base,
    ...(spec.text ? { text: spec.text } : {}),
  });
  await session.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  return true;
}

/** Waits for a navigation the action may have started, then for the page to finish loading. */
async function settle(session: Session, before: string): Promise<void> {
  await delay(250);
  const deadline = Date.now() + SETTLE_MS;
  while (Date.now() < deadline) {
    try {
      const [state, url] = await evaluate<[string, string]>(
        session,
        "[document.readyState, location.href]",
      );
      if (state === "complete" || (state === "interactive" && url !== before))
        return;
    } catch {
      // The old document went away mid-navigation; ask the new one.
    }
    await delay(150);
  }
}

interface ViewResult {
  url: string;
  title: string;
  headings: string[];
  elements: string[];
  more: number;
  scrollY: number;
  height: number;
}

function formatView(view: ViewResult): string {
  return [
    `Page: "${view.title}" ${view.url}`,
    ...(view.headings.length ? [`Headings: ${view.headings.join(" | ")}`] : []),
    `Scrolled ${view.scrollY} of ${view.height}px. Elements (use ref to click or type):`,
    ...view.elements,
    ...(view.more > 0
      ? [`(${view.more} more; scroll or use target text to reach them)`]
      : []),
  ].join("\n");
}

export interface BrowserTool {
  run(
    params: BrowserToolParams,
    signal?: AbortSignal,
  ): Promise<BrowserToolResult>;
  /** The tab the user is looking at, or undefined when Chrome is unreachable. */
  currentPage(signal?: AbortSignal): Promise<BrowserToolPage | undefined>;
}

export function createBrowserTool(
  devToolsUrl: string,
  options: { fetch?: typeof fetch } = {},
): BrowserTool {
  const request = options.fetch ?? fetch;
  let current: string | undefined;

  const listPages = async (): Promise<PageTarget[]> => {
    const response = await request(`${devToolsUrl}/json/list`);
    const body: unknown = await response.json();
    if (!Array.isArray(body)) return [];
    return body.filter(
      (target): target is PageTarget =>
        isRecord(target) &&
        target.type === "page" &&
        typeof target.id === "string" &&
        typeof target.webSocketDebuggerUrl === "string" &&
        !String(target.url).startsWith("devtools://"),
    );
  };

  // The visible tab is the one on screen, whoever switched to it last.
  const resolveTarget = async (
    signal?: AbortSignal,
  ): Promise<PageTarget | undefined> => {
    const pages = await listPages();
    const shown: PageTarget[] = [];
    for (const page of pages) {
      let session: Session | undefined;
      try {
        session = await openSession(page.webSocketDebuggerUrl, signal);
        if (
          (await evaluate<string>(session, "document.visibilityState")) ===
          "visible"
        )
          shown.push(page);
      } catch {
        // A tab that cannot answer is not the one the user is using.
      } finally {
        session?.close();
      }
    }
    const pick =
      shown.find((page) => page.id === current) ??
      shown[0] ??
      pages.find((page) => page.id === current) ??
      pages[0];
    current = pick?.id;
    return pick;
  };

  const withPage = async <T>(
    signal: AbortSignal | undefined,
    work: (session: Session, page: PageTarget) => Promise<T>,
  ): Promise<T> => {
    const page = await resolveTarget(signal);
    if (!page) throw new Error("Chrome has no open tab");
    const session = await openSession(page.webSocketDebuggerUrl, signal);
    try {
      return await work(session, page);
    } finally {
      session.close();
    }
  };

  const view = async (
    session: Session,
    lead: string,
  ): Promise<BrowserToolResult> => {
    const result = await evaluate<ViewResult>(session, VIEW_SCRIPT);
    return {
      text: `${lead}\n${formatView(result)}`,
      page: { url: result.url, title: result.title },
    };
  };

  const tabList = async (lead: string): Promise<BrowserToolResult> => {
    const pages = await listPages();
    return {
      text: [
        lead,
        ...pages.map(
          (page, index) =>
            `${index}. ${page.id === current ? "(current) " : ""}"${page.title}" ${page.url}`,
        ),
      ].join("\n"),
    };
  };

  return {
    async currentPage(signal) {
      try {
        const page = await resolveTarget(signal);
        return page ? { url: page.url, title: page.title } : undefined;
      } catch {
        return undefined;
      }
    },
    async run(params, signal) {
      switch (params.action) {
        case "tabs":
          await resolveTarget(signal);
          return tabList("Tabs:");
        case "switch_tab": {
          const pages = await listPages();
          const page = pages[params.tab ?? -1];
          if (!page) return tabList("No such tab. Tabs:");
          await request(`${devToolsUrl}/json/activate/${page.id}`);
          current = page.id;
          return withPage(signal, (session) =>
            view(session, `Switched to tab ${params.tab}.`),
          );
        }
        case "new_tab": {
          const url = params.url ? `?${encodeURI(params.url)}` : "";
          const response = await request(`${devToolsUrl}/json/new${url}`, {
            method: "PUT",
          });
          const created: unknown = await response.json();
          if (isRecord(created) && typeof created.id === "string") {
            current = created.id;
            await request(`${devToolsUrl}/json/activate/${created.id}`);
          }
          return withPage(signal, async (session, page) => {
            await settle(session, page.url);
            return view(session, "Opened a new tab.");
          });
        }
        default:
          return withPage(signal, async (session, page) => {
            const before = page.url;
            switch (params.action) {
              case "look":
                return view(session, "Current page.");
              case "open": {
                if (!params.url) return { text: "open needs url." };
                await session.send("Page.navigate", { url: params.url });
                await settle(session, before);
                return view(session, `Opened ${params.url}.`);
              }
              case "back":
                await evaluate(session, "history.back()");
                await settle(session, before);
                return view(session, "Went back.");
              case "scroll": {
                const to = {
                  up: "scrollBy(0, -innerHeight * 0.8)",
                  down: "scrollBy(0, innerHeight * 0.8)",
                  top: "scrollTo(0, 0)",
                  bottom: "scrollTo(0, document.documentElement.scrollHeight)",
                }[params.direction ?? "down"];
                await evaluate(session, to);
                await delay(300);
                return view(session, `Scrolled ${params.direction ?? "down"}.`);
              }
              case "press": {
                if (!params.key || !(await pressKey(session, params.key)))
                  return {
                    text: `press needs one of: ${Object.keys(KEYS).join(", ")}.`,
                  };
                await settle(session, before);
                return view(session, `Pressed ${params.key}.`);
              }
              case "read": {
                const offset = params.offset ?? 0;
                const text = await evaluate<string>(
                  session,
                  `(document.querySelector('main') || document.body).innerText.replace(/\\n{3,}/g, '\\n\\n')`,
                );
                const slice = (text ?? "").slice(offset, offset + READ_CHARS);
                const rest = (text ?? "").length - offset - slice.length;
                return {
                  text: `Page: "${page.title}" ${page.url}\n${slice}${rest > 0 ? `\n(${rest} more characters; read with offset ${offset + slice.length})` : ""}`,
                  page: { url: page.url, title: page.title },
                };
              }
              case "click":
              case "type": {
                const fields = params.action === "type";
                const found = await evaluate<{
                  label: string;
                  x: number;
                  y: number;
                } | null>(
                  session,
                  locateScript(params.ref, params.target, fields),
                );
                if (!found)
                  return view(
                    session,
                    `No element matches ${params.ref ? `ref ${params.ref}` : `"${params.target ?? ""}"`}; refs change after every view.`,
                  );
                await delay(100);
                if (params.action === "click") {
                  for (const type of ["mousePressed", "mouseReleased"])
                    await session.send("Input.dispatchMouseEvent", {
                      type,
                      x: found.x,
                      y: found.y,
                      button: "left",
                      clickCount: 1,
                    });
                  await settle(session, before);
                  return view(session, `Clicked "${found.label}".`);
                }
                await session.send("Input.dispatchMouseEvent", {
                  type: "mousePressed",
                  x: found.x,
                  y: found.y,
                  button: "left",
                  clickCount: 3,
                });
                await session.send("Input.dispatchMouseEvent", {
                  type: "mouseReleased",
                  x: found.x,
                  y: found.y,
                  button: "left",
                  clickCount: 3,
                });
                await evaluate(
                  session,
                  "document.activeElement && document.activeElement.select && document.activeElement.select()",
                );
                await session.send("Input.insertText", {
                  text: params.text ?? "",
                });
                let outcome = "";
                if (params.submit) {
                  await pressKey(session, "Enter");
                  await settle(session, before);
                  // Report a submit only when the page moved; otherwise try
                  // the field's own form once before saying so.
                  const moved = async () =>
                    (await evaluate<string>(session, "location.href")) !==
                    before;
                  if (!(await moved())) {
                    const submitted = await evaluate<boolean>(
                      session,
                      "(() => { const form = document.activeElement && document.activeElement.form; if (!form) return false; form.requestSubmit(); return true; })()",
                    );
                    if (submitted) await settle(session, before);
                  }
                  outcome = (await moved())
                    ? " and submitted"
                    : " and pressed Enter, but the page address did not change";
                }
                return view(session, `Typed into "${found.label}"${outcome}.`);
              }
              default:
                return { text: `Unknown action ${String(params.action)}.` };
            }
          });
      }
    },
  };
}
