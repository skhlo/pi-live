---
name: pi-handoff
description: Hand a request to Pi, the coding agent for this checkout, and relay its reply. Use when the user asks Pi to do or answer something, including by voice.
---

# Pi hand-off

Pi keeps one conversation for these hand-offs, so later requests can refer to
earlier ones.

1. Run this as the whole command, with the checkout root as the working
   directory:

   ```sh
   pi -p --session-id codex-voice --thinking low '<request>'
   ```

   Write the request as the user put it, plus any context from this conversation
   that Pi needs. Keep it inside single quotes; write an apostrophe as `'\''`.
   The repository's `.codex/rules/pi-handoff.rules` allows exactly this prefix
   to run outside the sandbox without a prompt, and only while the command stays
   bare: a `cd`, pipe, redirect, variable or substitution sends it back into the
   sandbox, where Pi cannot start.

   The command is done when it exits. Pi may take from seconds to minutes, so
   wait with a long timeout; in a voice conversation, say that Pi is on it first.

2. Relay Pi's final reply, shortened for speech in a voice conversation. If the
   command fails, report its error text.

Pi has no browser tool in these runs. Web work stays with Codex's own browser.
