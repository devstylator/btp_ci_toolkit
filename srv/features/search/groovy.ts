/**
 * Lightweight Groovy scanner for the search: finds declared variables and the exchange properties / headers a CPI
 * script reads or writes through the message API. It is a heuristic (no Groovy parser): comments are ignored,
 * names must be string literals, slashy strings are not recognised.
 */

export type GroovyKind = 'VARIABLE' | 'PROPERTY_READ' | 'PROPERTY_WRITE' | 'HEADER_READ' | 'HEADER_WRITE'

export interface GroovyFinding {
  kind: GroovyKind
  name: string
  /** Initializer of a variable, the value passed to a setter; empty for reads. */
  value: string
  line: number
}

const MAX_VALUE = 1000

/**
 * Two copies of the source with identical offsets: `text` without comments, `code` additionally without the contents
 * of string literals (quotes kept), so patterns never match inside strings or comments.
 */
export function mask(src: string): { text: string; code: string } {
  const text = [...src]
  const code = [...src]
  // comments keep their line breaks; inside strings `code` drops them too, so a string never ends a statement
  const blank = (from: number, to: number, comment: boolean) => {
    for (let k = from; k < to; k++) {
      if (comment && src[k] === '\n') continue
      code[k] = ' '
      if (comment) text[k] = ' '
    }
  }
  let i = 0
  while (i < src.length) {
    if (src.startsWith('//', i)) {
      const end = src.indexOf('\n', i)
      const to = end < 0 ? src.length : end
      blank(i, to, true)
      i = to
    } else if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2)
      const to = end < 0 ? src.length : end + 2
      blank(i, to, true)
      i = to
    } else if (src[i] === '"' || src[i] === "'") {
      const quote = src.startsWith(src[i].repeat(3), i) ? src[i].repeat(3) : src[i]
      let k = i + quote.length
      while (k < src.length && !src.startsWith(quote, k) && (quote.length === 3 || src[k] !== '\n')) k += src[k] === '\\' ? 2 : 1
      blank(i + quote.length, Math.min(k, src.length), false)
      i = Math.min(k + quote.length, src.length)
    } else {
      i++
    }
  }
  return { text: text.join(''), code: code.join('') }
}

/** String literal starting at `pos` (a quote): its content and the offset after the closing quote. */
function literalAt(text: string, pos: number): { value: string; end: number } | undefined {
  const q = text[pos]
  if (q !== '"' && q !== "'") return undefined
  const quote = text.startsWith(q.repeat(3), pos) ? q.repeat(3) : q
  let k = pos + quote.length
  while (k < text.length && !text.startsWith(quote, k)) {
    if (quote.length === 1 && text[k] === '\n') return undefined
    k += text[k] === '\\' ? 2 : 1
  }
  if (k >= text.length) return undefined
  return { value: text.slice(pos + quote.length, k), end: k + quote.length }
}

const OPEN = '([{'
const CLOSE = ')]}'

/**
 * Expression starting at `pos`, up to a stop character at bracket depth 0 or an unbalanced closing bracket.
 * For `statement` a line break also ends the expression unless the line obviously continues.
 */
function expressionAt(text: string, code: string, pos: number, statement: boolean): string {
  let depth = 0
  let k = pos
  for (; k < code.length; k++) {
    const c = code[k]
    if (OPEN.includes(c)) depth++
    else if (CLOSE.includes(c)) {
      if (depth === 0) break
      depth--
    } else if (depth === 0) {
      if (c === ';' || (!statement && c === ',')) break
      if (statement && c === '\n') {
        const before = code.slice(pos, k).trimEnd()
        const after = code.slice(k + 1).trimStart()
        if (!/[-+*/=&|?:,.]$/.test(before) && !/^(\?\.|\.|\?:|\+|&&|\|\|)/.test(after)) break
      }
    }
  }
  return text.slice(pos, k).replace(/\s+/g, ' ').trim().slice(0, MAX_VALUE)
}

const skipSpaces = (s: string, pos: number) => { while (pos < s.length && /\s/.test(s[pos])) pos++; return pos }

const kindOf = (what: string, write: boolean): GroovyKind =>
  `${/^propert/i.test(what) ? 'PROPERTY' : 'HEADER'}_${write ? 'WRITE' : 'READ'}` as GroovyKind

// message.getProperty("x") / setProperty("x", v) / getHeader("x", String) / setHeader("x", v)
const ACCESSOR = /([\w$]*)\s*\??\.\s*(get|set)(Property|Header)\s*\(\s*(?=["'])/g
// message.getProperties().get("x") / .put("x", v), message.getHeaders().get("x") / getHeader("x") ...
const MAP = String.raw`(?:\.\s*get(Properties|Headers)\s*\(\s*\)|\bmessage\s*\.\s*(properties|headers)\b)`
const MAP_CALL = new RegExp(`${MAP}\\s*\\??\\.\\s*(get|getHeader|getProperty|put|containsKey)\\s*\\(\\s*(?=["'])`, 'g')
// message.getHeaders()["x"] (= v)
const MAP_INDEX = new RegExp(`${MAP}\\s*\\[\\s*(?=["'])`, 'g')
// def x = ..., String x, final Map<String, Object> m = [:], int[] a = ...
const DECLARATION = /(?<![\w$.])(?:(?:final|static|private|protected|public)\s+)*(?:@\w+\s+)?(def|var|boolean|byte|char|short|int|long|float|double|[A-Z][\w$]*(?:\.[A-Z][\w$]*)*(?:\s*<[^;=(){}]*?>)?(?:\s*\[\s*\])*)[ \t]+([A-Za-z_$][\w$]*)[ \t]*(?:(=)(?![=~])|(?=;|\r?$))/gm

export function scanGroovy(src: string): GroovyFinding[] {
  const { text, code } = mask(src)
  const lineStarts = [0]
  for (let k = 0; k < src.length; k++) if (src[k] === '\n') lineStarts.push(k + 1)
  const lineOf = (pos: number) => {
    let lo = 0, hi = lineStarts.length - 1
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1 }
    return lo + 1
  }
  const out: (GroovyFinding & { pos: number })[] = []
  const seen = new Set<string>()
  const add = (kind: GroovyKind, name: string, value: string, pos: number) => {
    // `getHeaders().getHeader("x")` matches both the accessor and the map pattern
    if (seen.has(`${kind}@${pos}`)) return
    seen.add(`${kind}@${pos}`)
    out.push({ kind, name, value, line: lineOf(pos), pos })
  }

  // value after `"name"` when the call continues with `, value`
  const argumentAfter = (end: number) => {
    const p = skipSpaces(code, end)
    return code[p] === ',' ? expressionAt(text, code, skipSpaces(code, p + 1), false) : ''
  }

  for (const m of code.matchAll(ACCESSOR)) {
    if (m[1] === 'System') continue
    const lit = literalAt(text, m.index + m[0].length)
    if (!lit) continue
    const write = m[2] === 'set'
    add(kindOf(m[3], write), lit.value, write ? argumentAfter(lit.end) : '', m.index + m[0].length)
  }
  for (const m of code.matchAll(MAP_CALL)) {
    const lit = literalAt(text, m.index + m[0].length)
    if (!lit) continue
    const write = m[3] === 'put'
    add(kindOf(m[1] ?? m[2], write), lit.value, write ? argumentAfter(lit.end) : '', m.index + m[0].length)
  }
  for (const m of code.matchAll(MAP_INDEX)) {
    const lit = literalAt(text, m.index + m[0].length)
    if (!lit) continue
    let p = skipSpaces(code, lit.end)
    if (code[p] !== ']') continue
    p = skipSpaces(code, p + 1)
    const write = code[p] === '=' && code[p + 1] !== '='
    add(kindOf(m[1] ?? m[2], write), lit.value, write ? expressionAt(text, code, skipSpaces(code, p + 1), true) : '', m.index + m[0].length)
  }
  for (const m of code.matchAll(DECLARATION)) {
    const value = m[3] ? expressionAt(text, code, skipSpaces(code, m.index + m[0].length), true) : ''
    add('VARIABLE', m[2], value, m.index + m[0].length - (m[3] ? 1 : 0))
  }
  return out.sort((a, b) => a.pos - b.pos).map(({ pos, ...f }) => f)
}
