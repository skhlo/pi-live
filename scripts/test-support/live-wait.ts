import assert from "node:assert/strict";

export async function waitForCondition(
  check: () => boolean,
  description: string,
  queue: "microtask" | "task" = "task",
): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!check()) {
    if (performance.now() >= deadline) assert.fail(description);
    if (queue === "task")
      await new Promise<void>((resolve) => setImmediate(resolve));
    else await Promise.resolve();
  }
}
