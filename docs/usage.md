# Using Pi Live

Commands, the widget and what happens while Pi works. Install steps are in
the [README](../README.md#install).

The package exports one Pi extension factory. Discovery registers `/live`,
`Ctrl+Shift+L`, the historical live-message renderer, public lifecycle, dialog
and delegation listeners, and the `live_browser` tool, which stays inactive
until a browser-mode call connects it. Discovery does not load the native addon,
resolve credentials, create call timers, touch ownership or contact a provider.

- `/live` toggles voice; `start` and `stop` are explicit forms, and `end` or
  `off` also stop. `browser` starts a browser-mode call (see [browser mode](browser-mode.md)). Each new attempt requires ordinary TUI consent. The shifted shortcut follows the same path;
  commands remain the fallback for unsupported shifted-key encoding.
- `mute` stops microphone capture while speaker playback may continue. `unmute`
  reopens capture only within the same active call.
- `setup` prepares this account's home for calls; see [Install](../README.md#install).
- `voice <name>` changes the host-local preference while off. `status` reports
  state, mute, voice, compatibility and a fixed last-failure code. `help` explains
  controls, data sharing and limitations.
- The render-only `pi-live` widget shows input level, current role transcripts,
  mute and working state. It does not replace the footer/editor or intercept
  their keys. Teardown removes it; there is no widget animation timer.
- Voice requests become visible Pi messages, including while Pi is working.
  Pi handles follow-ups and typed input normally. When it settles, its successful
  reply returns to voice; if it has no reply, voice gets a short notice to check
  the terminal. Stopping voice stops audio and delivery, while Pi work continues.

Finishing a call releases its lock, so the same Pi session can start another.
The native audio library's close stops the speaker and the WebRTC connection;
its remote-audio task is not awaited, which is an accepted limit. Behind an
HTTPS proxy, the sideband's cleanup cannot be confirmed, so each call there ends
with `cleanup-blocked`.

Do not load another live extension alongside Pi Live. It refuses observed
conflicts with `@monotykamary/pi-better-openai` 0.2.6 and its pinned Git source,
and refuses account pooling announced by `pi-multiprovider`. These source and
command checks cannot inventory every extension or conflicting shortcut.
