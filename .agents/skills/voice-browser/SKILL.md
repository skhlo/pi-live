---
name: voice-browser
description: Voice web work. In a Codex voice conversation, do every web page step yourself in the current turn by calling tools.mcp__pi_live_browser__browser directly, including research. Use when a voice request needs a web page.
---

# Voice browser

1. Call `tools.mcp__pi_live_browser__browser` for each browser action. Start
   with `look` when the current page matters.
2. Act on the page each action returns: it is the check for that action, so the
   next call is the next step.
3. For research, open the topic's Wikipedia article by URL, read it, and answer
   from it; open one more page only when the article lacks the answer. A short
   spoken answer now serves voice better than a thorough one later.
4. Relay refusals and failures as the tool words them; the user takes those
   steps.
5. Reply in one or two short sentences for speech: what you did and what the
   page now shows.
