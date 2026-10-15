export interface CpiConnection {
  code: string
  tenantUrl: string
  tokenUrl: string
  clientId: string
  clientSecret: string
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
    const cacheKey = `${this.conn.code}|${this.conn.tokenUrl}|${this.conn.clientId}`
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
    const body = (await res.json()) as { access_token: string; expires_in?: number }
    tokenCache.set(cacheKey, {
      token: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? 300) * 1000
    })
    return body.access_token
  }

  private async fetch(url: string, init: RequestInit, what: string): Promise<Response> {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    } catch (e: any) {
      throw new CpiError(`${what} failed: ${e?.cause?.message ?? e?.message ?? e}`)
    }
  }

  /** GET a single entity or entity set; follows `__next` paging. Returns undefined on HTTP 404. */
  async get<T = any>(path: string): Promise<T[] | undefined> {
    const token = await this.getToken()
    const base = this.conn.tenantUrl.replace(/\/+$/, '')
    let url: string | undefined = `${base}/api/v1/${path}${path.includes('?') ? '&' : '?'}$format=json`
    const out: T[] = []
    while (url) {
      const res = await this.fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
      }, `GET ${path}`)
      if (res.status === 404) return undefined
      if (!res.ok) throw new CpiError(`GET ${path} failed: HTTP ${res.status}`, res.status)
      const d = ((await res.json()) as any).d
      if (Array.isArray(d?.results)) {
        out.push(...d.results)
        url = d.__next
      } else {
        out.push(d)
        url = undefined
      }
    }
    return out
  }
}
