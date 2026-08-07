/** Joins class names, dropping falsy parts. Replaces emotion's `cx`. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
