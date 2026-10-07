export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isStringList(value: JsonValue | undefined): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** JSON.parse that yields null instead of throwing. */
export function parseJson(raw: string): JsonValue | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
