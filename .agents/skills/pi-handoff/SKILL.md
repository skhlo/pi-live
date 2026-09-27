---
name: pi-handoff
description: Hand a request to Pi, the coding agent for this checkout, and relay its reply. Use when the user asks Pi to do or answer something, including by voice.
---

# Pi handoff

Pi keeps one conversation for these handoffs, so later requests can refer to
earlier ones.

1. Run this as the whole command, with the checkout root as the working
   directory:

   ```sh
   pi -p --session-id codex-handoff --thinking low "<request>"
   ```

   Write the request as the user put it, plus any context from this conversation
   that Pi needs. Keep it inside double quotes as plain words: apostrophes are
   fine; rephrase to leave out `$`, backticks, backslashes and double quotes.
   Add no other flags. The repository's `.codex/rules/pi-handoff.rules` allows
   this prefix to run outside the sandbox without a prompt, and only while the
   command stays that plain: a `cd`, pipe, redirect, variable, substitution or
   escape sends it back into the sandbox, where Pi cannot start.

   The command is done when it exits. Pi may take from seconds to minutes, so
   wait with a long timeout; in a voice conversation, say that Pi is on it first.

2. Relay Pi's final reply, shortened for speech in a voice conversation. If the
   command fails, report its error text.

Pi has no browser tool in these runs. Web work stays with Codex.
