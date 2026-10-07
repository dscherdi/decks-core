/** Lowercase hex SHA-256 through Web Crypto (browsers, workers, Node 19+). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = typeof crypto === "undefined" ? undefined : crypto.subtle;
  if (!subtle) throw new Error("SHA-256 is not available in this environment");
  const digest = await subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
