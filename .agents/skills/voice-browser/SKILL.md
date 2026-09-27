---
name: voice-browser
description: Web browser work in a Codex voice conversation, with the pi_live_browser MCP server's browser tool. Use when a voice request needs a web page.
---

# Voice browser

1. Use the `browser` tool from the `pi_live_browser` MCP server for each browser
   action. Start with `look` when the current page matters; stay in the current
   tab unless the user asks for a new one.
2. Act on the page each action returns: click or type by its numbered ref, or by
   the visible text in `target`. The returned page is the check; move on
   without a separate `look`.
3. A refusal means the step is buying, paying, deleting, sending, booking or
   signing in. Tell the user to do that step themselves.
4. When no Chrome answers, relay the tool's message: the user starts the browser
   sidecar or sets `PI_LIVE_BROWSER_CDP`.
5. Reply in one or two short sentences for speech: what you did and what the
   page now shows.
