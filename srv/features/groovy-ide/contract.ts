/**
 * Request/response contract of the script-runner iFlow (blog "CI based Script tester & ABAP Groovy IDE").
 * Request: JSON { inputScript, inputPayload, inputParams, inputHdrs }, all Base64; params/headers as `Name=Value;...`.
 * Response (200 or 400 for Groovy errors): JSON { properties, headers, payload, console | error }, all Base64;
 * properties/headers as `name = value;` pairs. Framework-free so it can be unit tested.
 */

export interface NameValue { name: string; value: string }

export interface RunInput {
  script: string
  payload?: string | null
  headers?: NameValue[] | null
  properties?: NameValue[] | null
}

export interface RunOutput {
  success: boolean
  httpStatus: number
  body: string
  headers: NameValue[]
  properties: NameValue[]
  console: string
  error: string
}

/** Properties the runner iFlow itself sets; they are not part of the script's result. */
const INTERNAL_PROPERTIES = new Set(['inputScript', 'consoleLog'])

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64')
const unb64 = (text: unknown) => typeof text === 'string' ? Buffer.from(text, 'base64').toString('utf8') : ''

/** `Name=Value;...` as the runner's decoder splits it (on `;` and `=`); such characters cannot be transported. */
export function encodeMap(list: NameValue[] | null | undefined, what: string): string {
  const rows = (list ?? []).filter(r => r?.name?.trim())
  for (const { name, value } of rows) {
    if (/[;=]/.test(name) || /[;=]/.test(value ?? '')) {
      throw new Error(`${what} '${name}': names and values must not contain ';' or '=' (runner iFlow format)`)
    }
  }
  return rows.map(r => `${r.name.trim()}=${r.value ?? ''}`).join(';')
}

export function buildRequest(input: RunInput) {
  return {
    inputScript: b64(input.script),
    inputPayload: b64(input.payload ?? ''),
    inputParams: b64(encodeMap(input.properties, 'Property')),
    inputHdrs: b64(encodeMap(input.headers, 'Header'))
  }
}

/**
 * Parses `name = value;` pairs. Values may contain `;` (e.g. content types), so a new pair only starts where
 * `;` is followed by a token and ` = `.
 */
export function parseMap(text: string): NameValue[] {
  const out: NameValue[] = []
  for (const part of text.split(/;\s*(?=[^\s;=]+ = )/)) {
    const chunk = part.replace(/;\s*$/, '')
    const at = chunk.indexOf(' = ')
    if (at < 0) {
      if (chunk.trim()) out.push({ name: chunk.trim(), value: '' })
      continue
    }
    out.push({ name: chunk.slice(0, at).trim(), value: chunk.slice(at + 3) })
  }
  return out
}

/** Interprets the runner response. HTTP 400 with an `error` field is a Groovy error (script problem). */
export function parseResponse(status: number, data: unknown): RunOutput {
  let json: any = data
  if (Buffer.isBuffer(json)) json = json.toString('utf8')
  if (typeof json === 'string') {
    try { json = JSON.parse(json) } catch { json = undefined }
  }
  const isRunnerJson = json && typeof json === 'object' && ('payload' in json || 'error' in json)
  if (!isRunnerJson || (status !== 200 && status !== 400)) {
    const reason = status === 401 || status === 403
      ? 'authentication/authorization failed (check credentials and the ESBMessaging.send role)'
      : status === 404 ? 'endpoint not found (check the URL and that the runner iFlow is deployed)'
        : status >= 200 && status < 300 ? 'unexpected response format (is the endpoint the runner iFlow?)'
          : 'unexpected response'
    return {
      success: false, httpStatus: status, body: '', headers: [], properties: [], console: '',
      error: `Runner HTTP ${status}: ${reason}`
    }
  }
  return {
    success: status === 200 && !json.error,
    httpStatus: status,
    body: unb64(json.payload),
    headers: parseMap(unb64(json.headers)),
    properties: parseMap(unb64(json.properties)).filter(p => !INTERNAL_PROPERTIES.has(p.name)),
    console: unb64(json.console),
    error: unb64(json.error)
  }
}

/** Groovy files of a CPI artifact zip (iFlow: `src/main/resources/script/`, Script Collection: anywhere). */
export function isScriptPath(path: string): boolean {
  return /\.(groovy|gsh)$/i.test(path) && !path.startsWith('__MACOSX/')
}
