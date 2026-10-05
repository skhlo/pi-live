# Browser mode (experimental)

`/live browser`: the voice-browser controller, the sidecar script, and how
requests are routed between quick browser steps and Pi.

`/live browser` starts a call that sends quick browser commands to a fast
browser controller and everything else to Pi
([#16](https://github.com/skhlo/pi-live/issues/16)). It needs
[voice-browser](https://github.com/moritzkremb/jev-voice-browser) running
on the same host. Pi Live can offer to start it with Chrome for this Pi session,
or reuse a controller you start yourself. Pi Live
connects to `ws://127.0.0.1:8787`; set `PI_LIVE_BROWSER_URL` to another `ws://`
loopback address if needed. Pi needs `TYPESAFE_API_KEY` (or `JEV_API_KEY`) for
routing. When voice-browser drives a Chrome started with remote debugging, set
`PI_LIVE_BROWSER_CDP` (for example `http://127.0.0.1:9333`) to give Pi a
`live_browser` tool on that Chrome. While Pi owns a running sidecar, the tool
uses `http://127.0.0.1:9333` automatically when `PI_LIVE_BROWSER_CDP` is unset.
These settings and `VOICE_BROWSER_DIR` can live in a
gitignored `.env` at the checkout's root, as in `.env.example`; Pi Live reads
it when `/live browser` starts, reads no other variables from it, and prefers
values set in Pi's environment.

### Browser sidecar

Set `VOICE_BROWSER_DIR` to an installed voice-browser checkout to enable the
offer. When no controller answers at `ws://127.0.0.1:8787` (or `localhost`), `/live browser` asks
before starting Chrome and third-party voice-browser code with your TypeSafe
key. It waits up to about 15 seconds for the controller before starting the
voice call. Declining keeps today's externally managed browser behavior and
suppresses further offers in this Pi session. No checkout configured, a custom
controller endpoint, or no interactive confirmation UI means no offer or start.
An already answering controller is always reused, without a prompt or restart.

The sidecar keeps its Chrome window, logins, tabs and current page across calls,
`/live stop` and voice ending. The end of the Pi session, not only quitting Pi
(see **Browser sidecar** in [GLOSSARY.md](../GLOSSARY.md)), stops both processes if
this session started them, killing any still running after about 5 seconds. A Pi
crash leaves them running; the next Pi session reuses them without taking
ownership. Several Pi sessions can share a controller, but the session that
started it stops it on exit. There is no coordination between sessions.

Startup failures give one browser-mode notice naming the cause and the private
log file, stop what was started, and let the voice call continue with the
existing controller/Pi fallback behavior. Sidecar output goes to that log rather
than the Pi terminal. A sidecar's log is deleted when it stops, unless a notice
names it or the stop had to kill a process; kept logs stay in the host's
temporary directory.

[`scripts/browser-sidecar.sh`](../scripts/browser-sidecar.sh) starts Chrome and voice-browser together on one
host: a visible Chrome with its own profile and DevTools at
`http://127.0.0.1:9333`, and voice-browser attached to it on port 8787 (both
ports fixed). Set `VOICE_BROWSER_DIR` to a voice-browser checkout with its
dependencies installed (checked with commit `198a076`), and provide the key as
`TYPESAFE_API_KEY` or `JEV_API_KEY`. Settings the environment leaves unset come
from an env file named by `SIDECAR_KEY_FILE`, by default the checkout's `.env`.
The script uses Google Chrome's macOS path unless `SIDECAR_CHROME` names another
binary, and keeps its profile in `~/.cache/pi-live/browser-profile` unless
`SIDECAR_CHROME_PROFILE` names another; both may also come from the env file. Then start Pi with the key and
`PI_LIVE_BROWSER_CDP=http://127.0.0.1:9333` in its environment or `.env`. Ctrl+C stops
voice-browser and Chrome.

The script also remains usable directly from a terminal, with the same `.env`
that Pi Live reads.

### Browser requests

For each handoff, Pi Live asks TypeSafe's Jev model what kind of work the user's
request is:

- A single browser step (open a site, search, click a named link, scroll, type,
  go back, confirm, pick a number) goes to voice-browser, and voice says the
  observed outcome: done with the resulting page (or that it may still be
  loading), a confirmation question, or a numbered choice.
- A longer web task (several steps, comparing, reading a page, filling a form)
  goes to Pi with the page on screen. Pi uses `live_browser`, whose every action
  waits for the page and returns what it now shows, and runs at low thinking
  until it settles; then the previous level returns.
- Anything else, such as coding, goes to Pi unchanged.

When voice-browser refuses or fails a request, Pi gets it too, and so does a
request voice-browser was not running for, when Pi has `live_browser`. Without a
TypeSafe key, every request tries voice-browser first; `/live browser` warns
about that and about an unusable `PI_LIVE_BROWSER_CDP`. The router uses Node's
`fetch`, which ignores `HTTPS_PROXY` unless Node is configured for proxies (on
recent Node versions, `NODE_USE_ENV_PROXY=1`); where a proxy is required, routing fails and
requests go to voice-browser first.

`live_browser` refuses to click, submit or press Enter on anything that looks
like buying, paying, deleting, sending, booking or signing in, and says so; voice
cannot approve those steps, so the user does them. It presses Enter once per
submit and reports when the page did not navigate rather than trying again. `live_browser` appears
in Pi's tools once a browser-mode call has connected it and stays for the rest
of that Pi session, so handed-off work can finish after voice ends.

A newer browser request replaces one still waiting; work already handed to Pi,
or already routed to Pi, continues. Unfinished requests are withdrawn from
voice-browser so it stops asking Jev about them. Stopping voice does not undo a browser action already started.
GPT-Live's client handoff carries no text, so the voice model cannot rewrite a
vague request into a command; it is instructed to suggest a concrete option and
let the user say it. voice-browser follows only tabs it opened itself: after Pi
switches or opens a tab, quick commands still act on voice-browser's tab, so
`live_browser` keeps links in the current tab and opens new tabs only on request.
