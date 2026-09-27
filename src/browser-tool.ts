// Pi's browser tool for browser-mode calls. It drives the same Chrome as the
// voice-browser controller through its DevTools endpoint, so work handed to Pi
// continues on the page the user is looking at. Each action waits for any
// navigation it starts and returns a compact view of the result, so acting and
// checking take one call. Clicks and submits that look like buying, paying,
// deleting, sending, booking or signing in are refused: voice cannot approve
// them. It uses Node's built-in fetch and WebSocket only.

import { isRecord, type BrowserPage } from "./browser.ts";

const COMMAND_TIMEOUT_MS = 10_000;
const SETTLE_MS = 8_000;
const NAVIGATION_START_MS = 300;
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

const DIRECTIONS = ["up", "down", "top", "bottom"] as const;

export interface BrowserToolParams {
  action: BrowserToolAction;
  url?: string;
  ref?: number;
  target?: string;
  text?: string;
  submit?: boolean;
  key?: string;
  direction?: (typeof DIRECTIONS)[number];
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
    direction: { type: "string", enum: [...DIRECTIONS] },
    tab: { type: "integer", minimum: 0 },
    offset: { type: "integer", minimum: 0 },
  },
} as const;

/** Narrows tool-call arguments to the parameters the schema describes. */
export function browserToolParams(
  value: unknown,
): BrowserToolParams | undefined {
  if (!isRecord(value)) return undefined;
  const action = BROWSER_TOOL_ACTIONS.find((known) => known === value.action);
  if (!action) return undefined;
  const params: BrowserToolParams = { action };
  for (const key of ["url", "target", "text", "key"] as const) {
    const field = value[key];
    if (typeof field === "string") params[key] = field;
  }
  for (const key of ["ref", "tab", "offset"] as const) {
    const field = value[key];
    if (typeof field === "number" && Number.isInteger(field) && field >= 0)
      params[key] = field;
  }
  if (typeof value.submit === "boolean") params.submit = value.submit;
  const direction = DIRECTIONS.find((known) => known === value.direction);
  if (direction) params.direction = direction;
  return params;
}

interface PageTarget {
  id: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

export interface BrowserToolResult {
  text: string;
  page?: BrowserPage;
}

interface DevToolsEvent {
  method: string;
  params: Record<string, unknown>;
}

interface Session {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** Listens for DevTools events until the returned function is called. */
  listen(listener: (event: DevToolsEvent) => void): () => void;
  close(): void;
}

function openSession(url: string, signal?: AbortSignal): Promise<Session> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map<
      number,
      { resolve(value: unknown): void; reject(error: Error): void }
    >();
    const listeners = new Set<(event: DevToolsEvent) => void>();
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
      if (!isRecord(message)) return;
      if (typeof message.method === "string") {
        const params = isRecord(message.params) ? message.params : {};
        for (const listener of listeners)
          listener({ method: message.method, params });
        return;
      }
      if (typeof message.id !== "number") return;
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
        listen(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        close: () => socket.close(),
      }),
    );
  });
}

async function evaluate(
  session: Session,
  expression: string,
): Promise<unknown> {
  const result = await session.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (isRecord(result) && isRecord(result.exceptionDetails))
    throw new Error("page script failed");
  return isRecord(result) && isRecord(result.result)
    ? result.result.value
    : undefined;
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const str = (value: unknown): string =>
  typeof value === "string" ? value : "";
const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;
const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

// In-page helpers shared by the scripts below. Refs are data attributes set by
// the last view, so a ref stays valid until the next view or navigation.
// RISK matches controls whose effect voice cannot approve.
const PAGE_HELPERS = `
const SEL = 'a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=option],[role=combobox],[contenteditable=true],summary';
const FIELDS = 'input:not([type=hidden]),textarea,select,[contenteditable=true],[role=combobox]';
const RISK = /\\b(buy|purchase|pay|checkout|check out|place (an )?order|order now|delete|send|book|reserve|sign ?in|log ?in|sign ?up|register|subscribe|transfer)\\b|구매|결제|주문|삭제|보내기|전송|예약|로그인|회원가입|購入|注文|削除|送信|予約|ログイン/i;
const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
const inView = (el) => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; };
const labelOf = (el) => clean(el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].innerText) || el.innerText || el.value || el.placeholder || el.title || el.getAttribute('alt') || el.name).slice(0, 80);
const roleOf = (el) => el.getAttribute('role') || (el.tagName === 'A' ? 'link' : el.tagName === 'INPUT' ? (el.type || 'text') : el.tagName.toLowerCase());
const riskyForm = (form) => !!form && [...form.elements].some((e) => e.type === 'password' || ((e.type === 'submit' || e.tagName === 'BUTTON') && RISK.test(labelOf(e))));
const riskyControl = (el) => !!el && (el.type === 'password' || RISK.test(labelOf(el)) || ((el.type === 'submit' || el.tagName === 'BUTTON') && riskyForm(el.form)));
const find = (ref, target, fields) => {
  if (ref) { const el = document.querySelector('[data-pi-ref="' + ref + '"]'); if (el) return el; }
  if (!target) return null;
  const want = clean(target).toLowerCase();
  const pool = [...document.querySelectorAll(fields ? FIELDS : SEL)].filter(visible);
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
    const field = el.matches(FIELDS);
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
  params: BrowserToolParams,
  fields: boolean,
): string => `(() => {${PAGE_HELPERS}
  const el = find(${JSON.stringify(params.ref ?? 0)}, ${JSON.stringify(params.target ?? "")}, ${fields});
  if (!el) return null;
  const risky = ${fields ? `el.type === 'password' || (${params.submit === true} && riskyForm(el.form))` : "riskyControl(el)"};
  // Links that would open a new tab stay in this one, where voice-browser acts.
  if (!risky && el.tagName === 'A' && el.target === '_blank') el.removeAttribute('target');
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  return { label: labelOf(el), x: r.left + r.width / 2, y: r.top + r.height / 2, risky };
})()`;

const FOCUS_RISK_SCRIPT = `(() => {${PAGE_HELPERS}
  const el = document.activeElement;
  return { label: el ? labelOf(el) : '', risky: !!el && (riskyControl(el) || riskyForm(el.form)) };
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

async function click(
  session: Session,
  at: { x: number; y: number },
  clickCount = 1,
): Promise<void> {
  for (const type of ["mousePressed", "mouseReleased"])
    await session.send("Input.dispatchMouseEvent", {
      type,
      x: at.x,
      y: at.y,
      button: "left",
      clickCount,
    });
}

type Navigation = "none" | "navigated" | "loading";

/**
 * Runs an action and waits for any navigation it starts. Page events report a
 * navigation as soon as it is requested, so a form waiting on a slow server
 * counts as submitted instead of looking like nothing happened.
 */
async function navigating(
  session: Session,
  action: () => Promise<void>,
): Promise<Navigation> {
  await session.send("Page.enable");
  const tree = await session.send("Page.getFrameTree");
  const frame =
    isRecord(tree) && isRecord(tree.frameTree) && isRecord(tree.frameTree.frame)
      ? str(tree.frameTree.frame.id)
      : "";
  let requested = false;
  let committed = false;
  let inDocument = false;
  const stop = session.listen(({ method, params }) => {
    const frameId = isRecord(params.frame)
      ? str(params.frame.id)
      : str(params.frameId);
    if (frameId !== frame) return;
    if (
      method === "Page.frameRequestedNavigation" ||
      method === "Page.frameStartedLoading"
    )
      requested = true;
    else if (method === "Page.frameNavigated") committed = requested = true;
    else if (method === "Page.navigatedWithinDocument") inDocument = true;
  });
  try {
    await action();
    await delay(NAVIGATION_START_MS);
    const deadline = Date.now() + SETTLE_MS;
    while (requested && Date.now() < deadline) {
      if (committed) {
        try {
          if ((await evaluate(session, "document.readyState")) === "complete")
            return "navigated";
        } catch {
          // The new document is still being created.
        }
      }
      await delay(100);
    }
    return requested ? "loading" : inDocument ? "navigated" : "none";
  } finally {
    stop();
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

function asView(value: unknown): ViewResult {
  const view = isRecord(value) ? value : {};
  return {
    url: str(view.url),
    title: str(view.title),
    headings: strings(view.headings),
    elements: strings(view.elements),
    more: num(view.more),
    scrollY: num(view.scrollY),
    height: num(view.height),
  };
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

const refusal = (label: string): string =>
  `Refused: "${label}" looks like buying, paying, deleting, sending, booking or signing in. Voice cannot approve that; tell the user to do this step themselves.`;

const LOADING = " The page is still loading.";

export interface BrowserTool {
  run(
    params: BrowserToolParams,
    signal?: AbortSignal,
  ): Promise<BrowserToolResult>;
  /** The tab the user is looking at, or undefined when Chrome is unreachable. */
  currentPage(signal?: AbortSignal): Promise<BrowserPage | undefined>;
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
        typeof target.title === "string" &&
        typeof target.url === "string" &&
        typeof target.webSocketDebuggerUrl === "string" &&
        !target.url.startsWith("devtools://"),
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
        if ((await evaluate(session, "document.visibilityState")) === "visible")
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

  const withPage = async (
    signal: AbortSignal | undefined,
    work: (session: Session, page: PageTarget) => Promise<BrowserToolResult>,
  ): Promise<BrowserToolResult> => {
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
    const result = asView(await evaluate(session, VIEW_SCRIPT));
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

  const locate = async (
    session: Session,
    params: BrowserToolParams,
    fields: boolean,
  ) => {
    const found = await evaluate(session, locateScript(params, fields));
    if (!isRecord(found)) return undefined;
    return {
      label: str(found.label),
      x: num(found.x),
      y: num(found.y),
      risky: found.risky === true,
    };
  };

  const missing = (session: Session, params: BrowserToolParams) =>
    view(
      session,
      `No element matches ${params.ref ? `ref ${params.ref}` : `"${params.target ?? ""}"`}; refs change after every view.`,
    );

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
          const page = (await listPages())[params.tab ?? -1];
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
          return withPage(signal, async (session) => {
            for (let tries = 0; tries < 80; tries++) {
              if (
                (await evaluate(session, "document.readyState")) === "complete"
              )
                break;
              await delay(100);
            }
            return view(session, "Opened a new tab.");
          });
        }
        case "look":
          return withPage(signal, (session) => view(session, "Current page."));
        case "open":
          if (!params.url) return { text: "open needs url." };
          return withPage(signal, async (session) => {
            const moved = await navigating(session, async () => {
              await session.send("Page.navigate", { url: params.url });
            });
            return view(
              session,
              `Opened ${params.url}.${moved === "loading" ? LOADING : ""}`,
            );
          });
        case "back":
          return withPage(signal, async (session) => {
            // DevTools history, not history.back(): a page restored from
            // cache can replace the document before an evaluate returns.
            const history = await session.send("Page.getNavigationHistory");
            const entries =
              isRecord(history) && Array.isArray(history.entries)
                ? history.entries
                : [];
            const index = isRecord(history) ? Number(history.currentIndex) : 0;
            const previous: unknown = entries[index - 1];
            if (!isRecord(previous) || typeof previous.id !== "number")
              return view(session, "There was no earlier page to go back to.");
            const entryId = previous.id;
            const moved = await navigating(session, async () => {
              await session.send("Page.navigateToHistoryEntry", { entryId });
            });
            return view(
              session,
              `Went back.${moved === "loading" ? LOADING : ""}`,
            );
          });
        case "scroll":
          return withPage(signal, async (session) => {
            const direction = params.direction ?? "down";
            await evaluate(
              session,
              {
                up: "scrollBy(0, -innerHeight * 0.8)",
                down: "scrollBy(0, innerHeight * 0.8)",
                top: "scrollTo(0, 0)",
                bottom: "scrollTo(0, document.documentElement.scrollHeight)",
              }[direction],
            );
            await delay(300);
            return view(session, `Scrolled ${direction}.`);
          });
        case "read":
          return withPage(signal, async (session, page) => {
            const offset = params.offset ?? 0;
            const text = str(
              await evaluate(
                session,
                `(document.querySelector('main') || document.body).innerText.replace(/\\n{3,}/g, '\\n\\n')`,
              ),
            );
            const slice = text.slice(offset, offset + READ_CHARS);
            const rest = text.length - offset - slice.length;
            return {
              text: `Page: "${page.title}" ${page.url}\n${slice}${rest > 0 ? `\n(${rest} more characters; read with offset ${offset + slice.length})` : ""}`,
              page: { url: page.url, title: page.title },
            };
          });
        case "press":
          return withPage(signal, async (session) => {
            const key = params.key ?? "";
            if (!KEYS[key])
              return {
                text: `press needs one of: ${Object.keys(KEYS).join(", ")}.`,
              };
            if (key === "Enter") {
              const focus = await evaluate(session, FOCUS_RISK_SCRIPT);
              if (isRecord(focus) && focus.risky === true)
                return view(session, refusal(str(focus.label)));
            }
            const moved = await navigating(session, async () => {
              await pressKey(session, key);
            });
            return view(
              session,
              `Pressed ${key}.${moved === "loading" ? LOADING : ""}`,
            );
          });
        case "click":
          return withPage(signal, async (session) => {
            const found = await locate(session, params, false);
            if (!found) return missing(session, params);
            if (found.risky) return view(session, refusal(found.label));
            await delay(100);
            const moved = await navigating(session, () =>
              click(session, found),
            );
            return view(
              session,
              `Clicked "${found.label}".${moved === "loading" ? LOADING : ""}`,
            );
          });
        case "type":
          return withPage(signal, async (session) => {
            const found = await locate(session, params, true);
            if (!found) return missing(session, params);
            if (found.risky) return view(session, refusal(found.label));
            await delay(100);
            // Triple-click selects existing text so the new text replaces it.
            await click(session, found, 3);
            await evaluate(
              session,
              "document.activeElement && document.activeElement.select && document.activeElement.select()",
            );
            await session.send("Input.insertText", { text: params.text ?? "" });
            if (!params.submit)
              return view(session, `Typed into "${found.label}".`);
            // Enter is pressed once; a page that does not navigate is
            // reported as such rather than submitted again.
            const moved = await navigating(session, async () => {
              await pressKey(session, "Enter");
            });
            return view(
              session,
              moved === "none"
                ? `Typed into "${found.label}" and pressed Enter; the page did not navigate, so it may have updated in place or ignored Enter.`
                : `Typed into "${found.label}" and submitted.${moved === "loading" ? LOADING : ""}`,
            );
          });
      }
    },
  };
}
