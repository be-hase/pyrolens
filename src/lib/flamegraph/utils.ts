/** Escapes a user-typed string so it can be embedded in a RegExp literally. */
export function escapeStringForRegex(value: string): string {
  return value.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
}

/** Inverse of {@link escapeStringForRegex}. */
export function unEscapeStringFromRegex(value: string): string {
  return value.replace(/\\([-[\]{}()*+?.,\\^$|#\s])/g, '$1');
}
