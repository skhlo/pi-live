import assert from "node:assert/strict";

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function jsonObject(
  value: unknown,
  label: string,
): Record<string, unknown> {
  assert.ok(isJsonObject(value), `${label} must be a JSON object`);
  return value;
}

export function parseJsonObject(
  text: string,
  label: string,
): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  return jsonObject(value, label);
}
