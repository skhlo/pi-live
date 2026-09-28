---
name: voice-browser
description: Web browser work in a Codex voice conversation, with the pi_live_browser MCP server's browser tool. Use when a voice request needs a web page.
---

# Voice browser

1. Use the `browser` tool from the `pi_live_browser` MCP server for each browser
   action. Start with `look` when the current page matters.
2. Act on the page each action returns: it is the check for that action, so the
   next call is the next step.
3. Relay refusals and failures as the tool words them; the user takes those
   steps.
4. Reply in one or two short sentences for speech: what you did and what the
   page now shows.
