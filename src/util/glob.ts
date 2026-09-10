/**
 * Minimal glob matcher for ignore patterns: `*` matches within a path segment,
 * `**` matches across segments, `?` matches one character.
 * A pattern with no wildcard and no slash also matches any single path segment,
 * so "tmp" ignores every directory named tmp.
 */
export function matchesGlob(path: string, pattern: string): boolean {
  if (pattern.length === 0) return false;

  const isBare = !pattern.includes('/') && !pattern.includes('*') && !pattern.includes('?');
  if (isBare) return path.split('/').includes(pattern);

  const rx = globToRegExp(pattern);
  return rx.test(path);
}

export function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => matchesGlob(path, p));
}

function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] as string;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i++;
        if (pattern[i + 1] === '/') i++;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  // Anchor loosely: a pattern may describe a suffix of the absolute path.
  return new RegExp(`(^|/)${out}(/|$)`);
}
