import cds from '@sap/cds'
import { createHash } from 'node:crypto'
import { type HttpDestination } from '@sap-cloud-sdk/connectivity'
import { executeHttpRequest } from '@sap-cloud-sdk/http-client'
import { CPI_CONCURRENCY, eachLimit } from './async.js'
import { decrypt } from './crypto.js'
import { clientCredentialsToken, CpiError, lookupDestination } from './http-auth.js'
import { isAllowedUrl } from './urls.js'

const { SELECT, INSERT } = cds.ql

export const DB_PLATFORM = 'btp.toolkit.PlatformAccess'
export const PLATFORM_CODES = ['DEV', 'PROD'] as const

const REQUEST_TIMEOUT_MS = 30_000
const PAGE_SIZE = 200
const MAX_PAGES = 50
const CACHE_TTL_MS = 60_000
const PIR_OFFERING = 'it-rt'

export type PlatformConnection = {
  code: string
  connectionMode: 'DIRECT'
  smUrl: string
  tokenUrl: string
  clientId: string
  clientSecret: string
  cockpitUrl: string
} | {
  code: string
  connectionMode: 'DESTINATION'
  destinationName: string
  cockpitUrl: string
}

/** A Process Integration Runtime instance (service `it-rt`) and the roles it grants. No credentials. */
export interface Pir {
  id: string
  name: string
  plan: string          // integration-flow | api | '' (plan not visible to the Service Manager key)
  roles: string[]
  grantTypes: string[]
  parametersRead: boolean
  spaceName: string
  orgName: string
  createdAt: string
  cockpitLink: string
}

/** The two rows are not seeded (HDI table data would reset them on redeploy); created on first access. */
export async function ensurePlatformRows(): Promise<void> {
  const existing = new Set((await SELECT.from(DB_PLATFORM).columns('code')).map((r: any) => r.code))
  for (const code of PLATFORM_CODES) {
    if (existing.has(code)) continue
    try {
      await INSERT.into(DB_PLATFORM).entries({ code, connectionMode: 'DIRECT', enabled: false })
    } catch (e) {
      // a concurrent first read may have created it already
      if (!await SELECT.one.from(DB_PLATFORM).columns('code').where({ code })) throw e
    }
  }
}

/** Platform access of an environment, or the reason why it cannot be used. */
export async function readPlatformAccess(code: string): Promise<{ conn?: PlatformConnection; problem?: string; status?: number }> {
  if (!(PLATFORM_CODES as readonly string[]).includes(code)) return { problem: 'tenant must be DEV or PROD', status: 400 }
  const row = await SELECT.one.from(DB_PLATFORM).where({ code })
  if (!row?.enabled) return { problem: `BTP platform access for ${code} is not enabled (Configuration > BTP platform)`, status: 412 }
  const cockpitUrl = row.cockpitUrl?.trim() ?? ''
  if (cockpitUrl && !isAllowedUrl(cockpitUrl)) return { problem: `BTP platform access for ${code} has an invalid cockpit URL`, status: 412 }
  if (row.connectionMode === 'DESTINATION') {
    if (!row.destinationName?.trim()) return { problem: `BTP platform access for ${code} requires a destination name`, status: 412 }
    return { conn: { code, connectionMode: 'DESTINATION', destinationName: row.destinationName.trim(), cockpitUrl } }
  }
  if (!row.smUrl || !row.tokenUrl || !row.clientId || !row.clientSecretEnc) {
    return { problem: `BTP platform access for ${code} is not fully configured (Service Manager URL, token URL, client ID and secret are required)`, status: 412 }
  }
  if (!isAllowedUrl(row.smUrl) || !isAllowedUrl(row.tokenUrl)) return { problem: `BTP platform access for ${code} has an invalid URL`, status: 412 }
  return {
    conn: {
      code, connectionMode: 'DIRECT', smUrl: row.smUrl, tokenUrl: row.tokenUrl, clientId: row.clientId,
      clientSecret: decrypt(row.clientSecretEnc), cockpitUrl
    }
  }
}

/** Like `readPlatformAccess`, but rejects the request (400/412) when the access is not usable. */
export async function loadPlatformAccess(code: string, req: { reject: (status: number, msg: string) => never }): Promise<PlatformConnection> {
  const { conn, problem, status } = await readPlatformAccess(code)
  if (!conn) req.reject(status ?? 412, problem!)
  return conn!
}

/** BTP cockpit page of a service instance (subaccount > Instances and Subscriptions > instance detail). */
export function cockpitLink(cockpitUrl: string, globalAccountId?: string, subaccountId?: string, instanceId?: string): string {
  if (!cockpitUrl || !globalAccountId || !subaccountId || !instanceId) return ''
  const seg = encodeURIComponent
  return `${cockpitUrl.replace(/\/+$/, '')}/#/globalaccount/${seg(globalAccountId)}/subaccount/${seg(subaccountId)}` +
    `/service-instances&//detail/${seg(instanceId)}/?layout=TwoColumnsMidExpanded`
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []

/** Parameters of an `it-rt` instance look like `{ roles: [...], grant-types: [...] }` (xsuaa nests grant types). */
export const looksLikePir = (params: any): boolean =>
  !!params && typeof params === 'object' && Array.isArray(params.roles) && Array.isArray(params['grant-types']) && !('xsappname' in params)

/** Read-only client for the SAP Service Manager API (`/v1`). Never returns or logs credentials. */
export class ServiceManagerClient {
  constructor(private readonly conn: PlatformConnection) {}

  private async destination(): Promise<{ destination: HttpDestination; headers: Record<string, string> }> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (this.conn.connectionMode === 'DIRECT') {
      headers.Authorization = `Bearer ${await clientCredentialsToken(this.conn)}`
      return { destination: { url: this.conn.smUrl, authentication: 'NoAuthentication' }, headers }
    }
    return { destination: await lookupDestination(this.conn.destinationName, `the ${this.conn.code} BTP platform access`), headers }
  }

  private url(destination: HttpDestination, path: string): string {
    const root = new URL(`${destination.url.replace(/\/+$/, '')}/v1/`)
    const url = new URL(path, root)
    if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname) || url.username || url.password || url.hash) {
      throw new CpiError('Service Manager request URL must stay within the configured API')
    }
    return url.href
  }

  /** GET one resource; undefined on 404 (and 400/501: parameters not retrievable for that broker). */
  async get(path: string): Promise<any> {
    const { destination, headers } = await this.destination()
    let res
    try {
      res = await executeHttpRequest(destination, {
        method: 'GET', url: this.url(destination, path), headers, timeout: REQUEST_TIMEOUT_MS, maxRedirects: 0,
        validateStatus: () => true
      }, { fetchCsrfToken: false })
    } catch {
      throw new CpiError('Service Manager request failed (authentication, connection error or timeout)')
    }
    if ([400, 404, 501].includes(res.status)) return undefined
    if (res.status < 200 || res.status >= 300) throw new CpiError(`Service Manager GET failed: HTTP ${res.status}`, res.status)
    if (!res.data || typeof res.data !== 'object') throw new CpiError('Service Manager returned an invalid response')
    return res.data
  }

  /** All items of a list resource (`items`, paged with `max_items` / `token`). */
  async list(resource: string): Promise<any[]> {
    const out: any[] = []
    let token: string | undefined
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = new URLSearchParams({ max_items: String(PAGE_SIZE), ...(token ? { token } : {}) })
      const data = await this.get(`${resource}?${query}`)
      const items: any[] = Array.isArray(data?.items) ? data.items : []
      out.push(...items)
      token = typeof data?.token === 'string' && data.token ? data.token : undefined
      if (!token || !items.length || data.has_more_items === false || (data.num_items && out.length >= data.num_items)) break
    }
    return out
  }

  /**
   * PIR instances of the subaccount with their roles. An instance is a PIR when its plan belongs to the `it-rt`
   * offering; when the key cannot see the plan (e.g. plan `subaccount-audit`), by the shape of its parameters.
   */
  async listPirs(): Promise<Pir[]> {
    const [instances, plans, offerings] = await Promise.all([
      this.list('service_instances'), this.list('service_plans'), this.list('service_offerings')
    ])
    const offeringName = new Map(offerings.map(o => [o.id, o.catalog_name ?? o.name]))
    const planInfo = new Map(plans.map(p => [p.id, { plan: p.catalog_name ?? p.name ?? '', offering: offeringName.get(p.service_offering_id) }]))
    const pirs: Pir[] = []
    await eachLimit(instances, CPI_CONCURRENCY, async (instance) => {
      const known = planInfo.get(instance.service_plan_id)
      if (known && known.offering !== PIR_OFFERING) return
      const params = await this.get(`service_instances/${encodeURIComponent(instance.id)}/parameters`)
      if (!known && !looksLikePir(params)) return
      const ctx = instance.context ?? {}
      pirs.push({
        id: instance.id,
        name: instance.name ?? '',
        plan: known?.plan ?? '',
        roles: strings(params?.roles),
        grantTypes: strings(params?.['grant-types']),
        parametersRead: !!params,
        spaceName: ctx.space_name ?? '',
        orgName: ctx.organization_name ?? '',
        createdAt: instance.created_at ?? '',
        cockpitLink: cockpitLink(this.conn.cockpitUrl, ctx.global_account_id, instance.subaccount_id ?? ctx.subaccount_id, instance.id)
      })
    })
    return pirs.sort((a, b) => a.name.localeCompare(b.name))
  }
}

const pirCache = new Map<string, { at: number; pirs: Promise<Pir[]> }>()

/** `listPirs` cached for a minute per configuration, so browsing endpoint details does not re-read the subaccount. */
export function cachedPirs(conn: PlatformConnection): Promise<Pir[]> {
  // the secret is part of the key (hashed), so a rotated key does not reuse old results
  const key = createHash('sha256').update(JSON.stringify(conn)).digest('hex')
  const hit = pirCache.get(key)
  if (hit && hit.at + CACHE_TTL_MS > Date.now()) return hit.pirs
  const pirs = new ServiceManagerClient(conn).listPirs()
  pirCache.set(key, { at: Date.now(), pirs })
  pirs.catch(() => pirCache.delete(key))
  return pirs
}

/** PIRs granting at least one of the roles (exact, case-sensitive like CPI role checks). */
export function pirsForRoles(pirs: Pir[], roles: string[]): Pir[] {
  const wanted = new Set(roles.map(r => r.trim()).filter(Boolean))
  return wanted.size ? pirs.filter(p => p.roles.some(r => wanted.has(r))) : []
}

