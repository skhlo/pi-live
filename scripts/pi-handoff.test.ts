import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const root = new URL("../", import.meta.url);

// The rule only lets the skill's command out of Codex's sandbox while its
// pattern is exactly the command the skill tells Codex to run.
test("the Codex allow rule matches the pi-handoff skill's command", async () => {
  const skill = await readFile(
    new URL(".agents/skills/pi-handoff/SKILL.md", root),
    "utf8",
  );
  const rules = await readFile(
    new URL(".codex/rules/pi-handoff.rules", root),
    "utf8",
  );
  const command = skill.match(/^\s*(pi -p .*) "<request>"$/m)?.[1];
  const pattern = rules.match(/^\s*pattern = (\[.*\]),$/m)?.[1];
  assert.ok(command, "SKILL.md names no pi -p command");
  assert.ok(pattern, "pi-handoff.rules has no pattern");
  assert.deepEqual(command.split(" "), JSON.parse(pattern));
});
