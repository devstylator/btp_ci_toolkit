import { createHash } from 'node:crypto'
import { alwaysProvider, getDestination, getDestinationFromDestinationService, isHttpDestination, type HttpDestination } from '@sap-cloud-sdk/connectivity'
import { executeHttpRequest, type HttpResponse } from '@sap-cloud-sdk/http-client'
import { muteLoggers } from '@sap-cloud-sdk/util'
import { assertConnectionWritable } from './connections.js'
import { isAllowedUrl } from './urls.js'

// SDK debug output can include destination credentials. Report only sanitized application errors.
muteLoggers()

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

export class CpiError extends Error {
  constructor(message: string, public status?: number) {
    super(message)
    this.name = 'CpiError'
  }
}

const REQUEST_TIMEOUT_MS = 30_000
const tokenCache = new Map<string, { token: string; expiresAt: number }>()

/** Minimal client for the SAP Integration Suite (CPI) Management API (OData V2, JSON). */
export class CpiClient {
  constructor(private readonly conn: CpiConnection) {}

  private async getToken(): Promise<string> {
    if (this.conn.connectionMode !== 'DIRECT') throw new CpiError('Direct credentials are required')
    // Rotating a secret must invalidate the old token without retaining the secret as a cache key.
    const cacheKey = createHash('sha256').update(JSON.stringify(this.conn)).digest('hex')
    const cached = tokenCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token

    const basic = Buffer.from(`${this.conn.clientId}:${this.conn.clientSecret}`).toString('base64')
    const res = await this.fetch(this.conn.tokenUrl, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      },
      body: 'grant_type=client_credentials'
    }, 'token request')
    if (!res.ok) throw new CpiError(`Token request failed: HTTP ${res.status}`, res.status)
    let body: { access_token: string; expires_in?: number }
    try {
      body = await res.json() as typeof body
      if (typeof body?.access_token !== 'string' || !body.access_token) throw new Error()
    } catch {
      throw new CpiError('Token request returned an invalid response')
    }
    tokenCache.set(cacheKey, {
      token: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? 300) * 1000
    })
    return body.access_token
  }

  private async fetch(url: string, init: RequestInit, what: string): Promise<Response> {
    try {
      return await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    } catch {
      throw new CpiError(`${what} failed (connection error or timeout)`)
    }
  }

  private async destination(): Promise<HttpDestination> {
    if (this.conn.connectionMode === 'DIRECT') {
      return { url: this.conn.tenantUrl, authentication: 'NoAuthentication' }
    }
    let destination
    try {
      const lookup = process.env.NODE_ENV === 'production' ? getDestinationFromDestinationService : getDestination
      destination = await lookup({ destinationName: this.conn.destinationName, selectionStrategy: alwaysProvider, useCache: true })
    } catch {
      // SDK errors may contain credentials or upstream response bodies.
      throw new CpiError(`Destination lookup failed for ${this.conn.code}; check the destination and service binding`)
    }
    if (!destination) throw new CpiError(`Destination not found for ${this.conn.code}; check the configured destination name`)
    if (!isHttpDestination(destination) || !isAllowedUrl(destination.url) || destination.authentication !== 'OAuth2ClientCredentials' || destination.proxyType !== 'Internet') {
      throw new CpiError('Destination must use a valid HTTPS tenant base URL, OAuth2ClientCredentials authentication and Internet proxy type')
    }
    return destination
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

  private async request(destination: HttpDestination, url: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', data?: unknown): Promise<HttpResponse> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (this.conn.connectionMode === 'DIRECT') headers.Authorization = `Bearer ${await this.getToken()}`
    try {
      return await executeHttpRequest(destination, {
        method, url, data, headers, timeout: REQUEST_TIMEOUT_MS, maxRedirects: 0,
        validateStatus: () => true
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
}
