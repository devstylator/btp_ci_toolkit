/**
 * Search patterns: the text is found anywhere in the searched string ("contains"); `*` stands for any string
 * (also empty) and `+` for exactly one character. All other characters are literal.
 */
export function compilePattern(pattern: string, caseSensitive: boolean): RegExp {
  const source = [...pattern].map(c => c === '*' ? '.*' : c === '+' ? '.' : c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('')
  return new RegExp(source, caseSensitive ? 'su' : 'isu')
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
