import { readZip } from '../../lib/zip.js'

/** Pure helpers for the Endpoints feature: adapter guess from the URL, .iflw sender channel parsing, matching. */

export interface SenderChannel {
  name: string
  adapter: string
  address: string
  authentication: string
  userRole: string
  /** Allowed client certificates (subject/issuer), when the channel uses certificate authentication. */
  certificates: string
  /** All channel properties except ones that look like credentials. */
  properties: { key: string; value: string }[]
}

/** Runtime URL prefixes of CPI sender adapters. `/cxf/` is shared by SOAP, IDoc and XI, so the API protocol decides. */
const PATH_ADAPTERS: [RegExp, string][] = [
  [/^\/http\//i, 'HTTPS'],
  [/^\/gw\/odata\//i, 'OData'],
  [/^\/as2\//i, 'AS2'],
  [/^\/as4\//i, 'AS4']
]

const PROTOCOL_ADAPTERS: Record<string, string> = { SOAP: 'SOAP', IDOC: 'IDoc', XI: 'XI', ODATA: 'OData', REST: 'HTTPS', AS2: 'AS2' }

/** Best guess of the sender adapter type from the endpoint URL and the `Protocol` of the ServiceEndpoints API. */
export function adapterFromUrl(url: string, protocol?: string): string {
  let path = ''
  try {
    path = new URL(url).pathname
  } catch {
    path = url
  }
  for (const [pattern, adapter] of PATH_ADAPTERS) if (pattern.test(path)) return adapter
  const p = (protocol ?? '').trim()
  return PROTOCOL_ADAPTERS[p.toUpperCase()] ?? (p || (/^\/cxf\//i.test(path) ? 'SOAP' : ''))
}

/**
 * The `Id` of a ServiceEndpoints entry identifies the endpoint, e.g. `Orders$endpointAddress=http/orders`;
 * the artifact ID is the part before `$` (artifact IDs cannot contain `$`).
 */
export const artifactIdFromEndpointId = (id: string) => (id ?? '').split('$')[0].trim()

const SECRET_KEY = /password|secret|credential|privatekey/i

const decode = (s: string) => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, '&')
  .trim()

const attr = (tag: string, name: string) => {
  const m = new RegExp(`(?:^|\\s)(?:[\\w-]+:)?${name}\\s*=\\s*"([^"]*)"`).exec(tag)
  return m ? decode(m[1]) : ''
}

function properties(xml: string): Map<string, string> {
  const props = new Map<string, string>()
  const re = /<(?:[\w-]+:)?property\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?property>/g
  for (let m; (m = re.exec(xml));) {
    const key = /<key>([\s\S]*?)<\/key>/.exec(m[1])
    const value = /<value>([\s\S]*?)<\/value>/.exec(m[1])
    if (key) props.set(decode(key[1]), value ? decode(value[1]) : '')
  }
  return props
}

/** Case-insensitive lookup of the first non-empty property among candidate keys. */
function pick(props: Map<string, string>, ...keys: string[]): string {
  for (const want of keys) {
    for (const [k, v] of props) if (k.toLowerCase() === want.toLowerCase() && v) return v
  }
  return ''
}

export type ParsedChannel = Omit<SenderChannel, 'properties'> & { props: Map<string, string> }

/** Sender channels (message flows from a sender participant) of an `.iflw` (BPMN XML) file. */
export function parseSenderChannels(iflw: string): ParsedChannel[] {
  const senders = new Set<string>()
  for (const m of iflw.matchAll(/<(?:[\w-]+:)?participant\b([^>]*)>/g)) {
    if (attr(m[1], 'type') === 'EndpointSender') senders.add(attr(m[1], 'id'))
  }
  const channels: ParsedChannel[] = []
  const re = /<(?:[\w-]+:)?messageFlow\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w-]+:)?messageFlow>)/g
  for (let m; (m = re.exec(iflw));) {
    const props = properties(m[2] ?? '')
    const isSender = pick(props, 'direction').toLowerCase() === 'sender' || senders.has(attr(m[1], 'sourceRef'))
    if (!isSender) continue
    channels.push({
      name: attr(m[1], 'name') || pick(props, 'Name') || attr(m[1], 'id'),
      adapter: pick(props, 'ComponentType', 'Name'),
      address: pick(props, 'address', 'urlPath'),
      authentication: pick(props, 'senderAuthType', 'authenticationMethod', 'Authorization', 'authorizationType', 'authType'),
      userRole: pick(props, 'userRole', 'role', 'roleName'),
      certificates: pick(props, 'clientCertificates', 'senderClientCertificates', 'certificateSubjects'),
      props
    })
  }
  return channels
}

/** Replaces `{{param}}` placeholders with externalized parameter values (unknown ones are kept). */
export const resolveParams = (value: string, params: Map<string, string>) =>
  value.replace(/\{\{([^}]+)\}\}/g, (all, name) => params.get(name.trim()) ?? all)

/** Turns parsed channels into the API shape: placeholders resolved, credential-like properties dropped. */
export function toSenderChannels(parsed: ParsedChannel[], params: Map<string, string>): SenderChannel[] {
  return parsed.map(({ props, ...c }) => ({
    name: c.name,
    adapter: resolveParams(c.adapter, params),
    address: resolveParams(c.address, params),
    authentication: resolveParams(c.authentication, params),
    userRole: resolveParams(c.userRole, params),
    certificates: resolveParams(c.certificates, params),
    properties: [...props]
      .filter(([k]) => !SECRET_KEY.test(k))
      .map(([key, value]) => ({ key, value: resolveParams(value, params) }))
      .sort((a, b) => a.key.localeCompare(b.key))
  }))
}

/** Does the channel address (e.g. `/orders` or `/orders/*`) serve the endpoint URL (`https://host/http/orders`)? */
export function addressMatches(url: string, address: string): boolean {
  if (!address) return false
  let path: string
  try {
    path = decodeURIComponent(new URL(url).pathname)
  } catch {
    path = url
  }
  const rest = path.replace(/^\/(?:http|cxf|gw\/odata|as2|as4)(?=\/)/i, '').replace(/\/+$/, '')
  const want = ('/' + address.replace(/^\/+/, '')).replace(/\/+$/, '')
  const pattern = new RegExp('^' + want.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i')
  return pattern.test(rest) || rest.toLowerCase().endsWith(want.toLowerCase())
}

/** Finds the `.iflw` in a CPI artifact archive (also one level of nested zip/jar, as in runtime bundles). */
export function findIflw(archive: Buffer, depth = 0): string | undefined {
  let entries
  try {
    entries = readZip(archive)
  } catch {
    return undefined
  }
  const iflw = entries.find(e => e.path.endsWith('.iflw'))
  if (iflw) return iflw.read().toString('utf8')
  if (depth > 0) return undefined
  for (const e of entries.filter(e => /\.(zip|jar)$/i.test(e.path))) {
    const inner = findIflw(e.read(), depth + 1)
    if (inner) return inner
  }
  return undefined
}

/** OData V2 JSON dates come as `/Date(1700000000000)/`; also accepts ISO strings and epoch millis. */
export function odataDate(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  const m = /\/Date\((-?\d+)(?:[+-]\d+)?\)\//.exec(String(value))
  const d = m ? new Date(Number(m[1])) : new Date(/^\d+$/.test(String(value)) ? Number(value) : String(value))
  return isNaN(d.getTime()) ? null : d.toISOString()
}
