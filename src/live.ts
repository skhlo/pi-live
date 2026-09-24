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
