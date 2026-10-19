import { type HttpDestination } from '@sap-cloud-sdk/connectivity'
import { executeHttpRequest, type HttpResponse } from '@sap-cloud-sdk/http-client'
import { assertConnectionWritable } from './connections.js'
import { clientCredentialsToken, CpiError, lookupDestination } from './http-auth.js'

export { CpiError }

interface DirectConnection {
  code: string
  connectionMode: 'DIRECT'
  tenantUrl: string
  tokenUrl: string
  clientId: string
  clientSecret: string
}

export type CpiConnection = DirectConnection | {
  code: string
  connectionMode: 'DESTINATION'
  destinationName: string
}

const REQUEST_TIMEOUT_MS = 30_000

/** Minimal client for the SAP Integration Suite (CPI) Management API (OData V2, JSON). */
export class CpiClient {
  constructor(private readonly conn: CpiConnection) {}

  private async destination(): Promise<HttpDestination> {
    if (this.conn.connectionMode === 'DIRECT') {
      return { url: this.conn.tenantUrl, authentication: 'NoAuthentication' }
    }
    return lookupDestination(this.conn.destinationName, this.conn.code)
  }

  private apiUrl(destination: HttpDestination, path: string, previous?: string): string {
    const base = `${destination.url.replace(/\/+$/, '')}/api/v1/`
    const url = new URL(path, previous ?? base)
    const root = new URL(base)
    if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname) || url.username || url.password || url.hash) {
      throw new CpiError('CPI request URL must stay within the configured tenant API')
    }
    return url.href
  }

  private async request(destination: HttpDestination, url: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', data?: unknown, binary = false): Promise<HttpResponse> {
    const headers: Record<string, string> = { Accept: binary ? 'application/octet-stream, application/zip, */*' : 'application/json' }
    if (this.conn.connectionMode === 'DIRECT') headers.Authorization = `Bearer ${await clientCredentialsToken(this.conn)}`
    try {
      return await executeHttpRequest(destination, {
        method, url, data, headers, timeout: REQUEST_TIMEOUT_MS, maxRedirects: 0,
        validateStatus: () => true,
        ...(binary ? { responseType: 'arraybuffer' as const } : {})
      }, { fetchCsrfToken: method !== 'GET' })
    } catch {
      throw new CpiError(`CPI ${method} failed (authentication, connection error or timeout)`)
    }
  }

  /** All future mutating features must use this method. Never bypass the active configuration check. */
  async write(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, data?: unknown): Promise<unknown> {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new CpiError('Unsupported CPI write method')
    await assertConnectionWritable(this.conn.code)
    const destination = await this.destination()
    const res = await this.request(destination, this.apiUrl(destination, path), method, data)
    if (res.status < 200 || res.status >= 300) throw new CpiError(`CPI ${method} failed: HTTP ${res.status}`, res.status)
    return res.data
  }

  /** GET a single entity or entity set; follows `__next` paging. Returns undefined on HTTP 404. */
  async get<T = any>(path: string): Promise<T[] | undefined> {
    const destination = await this.destination()
    let url: string | undefined = this.apiUrl(destination, `${path}${path.includes('?') ? '&' : '?'}$format=json`)
    const out: T[] = []
    while (url) {
      const res = await this.request(destination, url, 'GET')
      if (res.status === 404) return undefined
      if (res.status < 200 || res.status >= 300) throw new CpiError(`CPI GET failed: HTTP ${res.status}`, res.status)
      const d = res.data?.d
      if (!d || typeof d !== 'object') throw new CpiError('CPI returned an invalid OData response')
      if (Array.isArray(d?.results)) {
        out.push(...d.results)
        url = d.__next ? this.apiUrl(destination, d.__next, url) : undefined
      } else {
        out.push(d)
        url = undefined
      }
    }
    return out
  }

  /** GET a media resource (e.g. `.../$value` artifact zip) as bytes. Returns undefined on HTTP 404. */
  async download(path: string): Promise<Buffer | undefined> {
    const destination = await this.destination()
    const res = await this.request(destination, this.apiUrl(destination, path), 'GET', undefined, true)
    if (res.status === 404) return undefined
    if (res.status < 200 || res.status >= 300) throw new CpiError(`CPI download failed: HTTP ${res.status}`, res.status)
    return Buffer.from(res.data)
  }
}
