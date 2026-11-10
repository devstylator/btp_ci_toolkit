/**
 * Search patterns (Search, Endpoints): the text is found anywhere in the searched string ("contains"); `*` stands
 * for any string (also empty) and `+` for exactly one character. All other characters are literal.
 */
export function compilePattern(pattern: string, caseSensitive: boolean): RegExp {
  const source = [...pattern].map(c => c === '*' ? '.*' : c === '+' ? '.' : c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('')
  return new RegExp(source, caseSensitive ? 'su' : 'isu')
}

/** Predicate for one pattern against any of the given texts; an empty pattern matches everything. */
export function anyMatcher(pattern: string | undefined, caseSensitive = false): (...texts: string[]) => boolean {
  const re = pattern?.trim() ? compilePattern(pattern.trim(), caseSensitive) : undefined
  return (...texts) => !re || texts.some(t => re.test(t ?? ''))
}

export interface Criteria {
  name?: string
  value?: string
  caseSensitive?: boolean
}

/** Predicate for findings: every given pattern must match (name AND value); empty patterns are ignored. */
export function matcher({ name, value, caseSensitive = false }: Criteria): (finding: { name: string; value: string }) => boolean {
  const n = name ? compilePattern(name, caseSensitive) : undefined
  const v = value ? compilePattern(value, caseSensitive) : undefined
  return f => (!n || n.test(f.name)) && (!v || v.test(f.value))
}
