/** Package metadata is untrusted input — never let it shape a path. */
export function safeFilename(text: string): string {
  return text.replace(/[^a-zA-Z0-9.+~_-]/g, '_');
}
