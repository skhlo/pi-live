# Codex browser server

The stdio MCP server that gives Codex voice the same browser tool Pi uses.
For people who would rather not pay API usage for voice; see the
[README](../README.md#three-ways-to-use-it).

Separate from Pi Live, `src/mcp.ts` is a stdio MCP server that gives Codex,
including Codex voice, one `browser` tool with the same actions and refusals as
`live_browser`. When Codex trusts this checkout, `.codex/config.toml` starts it
and the `.agents/skills/voice-browser` skill tells Codex how to use it in voice
conversations; its tool description asks Codex to prefer it there over other
browser or computer-use tools. It needs no new dependencies. Its calls skip
Codex's approval review, which added seconds per call by voice, so the tool's
refusals are the only guard. It runs one action at a time, and an action that
takes more than 30 seconds is abandoned.

It drives the Chrome at `PI_LIVE_BROWSER_CDP`, or else the one at
`http://127.0.0.1:9333`. Set it in the checkout's `.env`: the plain `codex`
command runs MCP servers under its background app server, so variables from the
shell that started Codex may not reach the server. `SIDECAR_CHROME` and
`SIDECAR_CHROME_PROFILE`, in the environment or the checkout's `.env`, name
another Chrome or profile; the sidecar script reads them the same way.

When nothing answers at a `127.0.0.1` address, the next browser action starts a
visible Chrome there, on the browser sidecar's profile
(`~/.cache/pi-live/browser-profile`) so logins carry over, brings its window to
the front, and its reply says so. Other loopback names, such as `localhost`,
only connect. Closing the window leaves Chrome running on macOS, so the next
action opens a new tab and brings it to the front; quitting Chrome means the
next action starts it again. Quitting Codex closes the Chrome it started: at
once with `codex exec`, and within about a minute with the plain `codex`
command, whose background app server stops idle servers. A Chrome already
answering, such as the sidecar's, is used as it is and left running. Only a
server killed outright leaves its Chrome behind, and the next Codex session then
reuses it. Several Codex sessions share one Chrome; when the one that started it
ends, the others' next action starts a new one.

Chrome runs one instance per profile, so use this server or Pi's browser
sidecar, not both at once: a sidecar started while this server's Chrome is open
attaches to that Chrome, which then closes with Codex.

The server itself does not use Jev, TypeSafe or the voice-browser controller.
Page content it returns goes to OpenAI through Codex.
