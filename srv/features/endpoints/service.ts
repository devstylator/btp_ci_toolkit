import cds from '@sap/cds'
import { CpiClient, CpiError } from '../../lib/cpi-client.js'
import { loadConnection } from '../../lib/connections.js'
import { CPI_CONCURRENCY, eachLimit } from '../../lib/async.js'
import { anyMatcher } from '../../lib/pattern.js'
import { adapterFromUrl, addressMatches, servicePath, artifactIdFromEndpointId, findIflw, odataDate, parseSenderChannels, toSenderChannels } from './iflow.js'

type Tenant = 'DEV' | 'PROD'
type Level = 'INFO' | 'WARN' | 'ERROR'
interface Message { tenant: Tenant; level: Level; message: string }

const TENANTS: Tenant[] = ['DEV', 'PROD']
const literal = (value: string) => `'${encodeURIComponent(value.replace(/'/g, "''"))}'`

/** Turns CPI call failures into 502 responses. */
const guard = (fn: (req: any) => Promise<any>) => async (req: any) => {
  try {
    return await fn(req)
  } catch (e) {
    if (e instanceof CpiError) req.reject(502, e.message)
    throw e
  }
}

interface EndpointRow {
  tenant: Tenant
  iflowId: string
  iflowName: string
  adapter: string
  protocol: string
  url: string
  path: string
  version: string
  authentication: string
  userRole: string
  roleSource: string
}

/** All entry points of a tenant (ServiceEndpoints), iFlow IDs/names resolved against the deployed artifacts. */
async function tenantEndpoints(client: CpiClient, tenant: Tenant, messages: Message[]): Promise<EndpointRow[]> {
  const list = await client.get('ServiceEndpoints?$expand=EntryPoints')
  if (!list) {
    messages.push({ tenant, level: 'ERROR', message: `${tenant}: ServiceEndpoints API not available` })
    return []
  }
  const runtime = await runtimeArtifacts(client, tenant, messages)
  return list.flatMap((ep: any) => {
    const artifact = resolveArtifact(ep, runtime)
    return (ep.EntryPoints?.results ?? []).map((entry: any) => ({
      tenant,
      iflowId: artifact?.Id ?? artifactIdFromEndpointId(ep.Id),
      iflowName: artifact?.Name || ep.Title || ep.Name || artifactIdFromEndpointId(ep.Id),
      adapter: adapterFromUrl(entry.Url ?? '', ep.Protocol),
      protocol: ep.Protocol ?? '',
      url: entry.Url ?? '',
      path: servicePath(entry.Url ?? ''),
      version: artifact?.Version ?? ep.Version ?? '',
      authentication: '',
      userRole: '',
      roleSource: ''
    }))
  })
}

/** IDs of the iFlows in a package; undefined when the package does not exist. */
async function packageIflowIds(client: CpiClient, packageId: string): Promise<Set<string> | undefined> {
  const list = await client.get(`IntegrationPackages(${literal(packageId)})/IntegrationDesigntimeArtifacts`)
  return list ? new Set(list.map((a: any) => a.Id)) : undefined
}

/** Sender channels of a deployed iFlow with parameters resolved; quiet (no messages) for list use. */
async function senderChannels(client: CpiClient, id: string, tenant: Tenant, messages: Message[] = []) {
  const { source, iflw } = await iflowContent(client, id, messages, tenant)
  if (!iflw) return { source, channels: [] }
  const parsed = parseSenderChannels(iflw)
  const needsParams = parsed.some(c => [...c.props.values()].some(v => v.includes('{{')))
  return { source, channels: toSenderChannels(parsed, needsParams ? await externalizedParams(client, id) : new Map()) }
}

const distinct = (values: string[]) => [...new Set(values.filter(Boolean))].join(', ')

/** Fills authentication/user role of the rows (one iFlow download per distinct iFlow). */
async function addAccessRoles(client: CpiClient, tenant: Tenant, rows: EndpointRow[], messages: Message[]) {
  const byIflow = new Map<string, EndpointRow[]>()
  for (const row of rows) byIflow.set(row.iflowId, [...(byIflow.get(row.iflowId) ?? []), row])
  const failed: string[] = []
  await eachLimit([...byIflow], CPI_CONCURRENCY, async ([id, list]) => {
    const { source, channels } = await senderChannels(client, id, tenant)
    if (source === 'NONE') failed.push(id)
    for (const row of list) {
      const matching = channels.filter(c => addressMatches(row.url, c.address))
      const used = matching.length ? matching : channels
      row.authentication = distinct(used.map(c => c.authentication))
      row.userRole = distinct(used.map(c => c.userRole))
      row.roleSource = source
    }
  })
  if (failed.length) {
    messages.push({ tenant, level: 'WARN', message: `Access role could not be read for ${failed.length} iFlow(s): ${failed.sort().join(', ')}` })
  }
}

/** All deployed artifacts of a tenant (one call); an empty list with a WARN when the API fails. */
async function runtimeArtifacts(client: CpiClient, tenant: Tenant, messages: Message[]): Promise<any[]> {
  try {
    return (await client.get('IntegrationRuntimeArtifacts')) ?? []
  } catch (e) {
    if (!(e instanceof CpiError)) throw e
    messages.push({ tenant, level: 'WARN', message: `${tenant}: deployed artifacts could not be read (${e.message}); iFlow IDs taken from the endpoint IDs` })
    return []
  }
}

/** Deployed artifact of a ServiceEndpoints entry: by the ID before `$`, else by the endpoint's name/title. */
function resolveArtifact(ep: any, runtime: any[]): any | undefined {
  const id = artifactIdFromEndpointId(ep.Id)
  return runtime.find(a => a.Id === id)
    ?? runtime.find(a => a.Id === ep.Name)
    ?? runtime.find(a => a.Name && (a.Name === ep.Name || a.Name === ep.Title))
}

/** Single deployed artifact; falls back to the list when the single GET fails (some tenants answer it with errors). */
async function runtimeArtifact(client: CpiClient, id: string, tenant: Tenant, messages: Message[]) {
  try {
    const one = (await client.get(`IntegrationRuntimeArtifacts(${literal(id)})`))?.[0]
    if (one) return one
  } catch (e) {
    if (!(e instanceof CpiError)) throw e
    messages.push({ tenant, level: 'INFO', message: `Deployed artifact '${id}': ${e.message}; searching the artifact list` })
  }
  const found = (await runtimeArtifacts(client, tenant, messages)).find(a => a.Id === id)
  if (!found) messages.push({ tenant, level: 'WARN', message: `Deployed artifact '${id}' not found on ${tenant}` })
  return found
}

/** The deployed `.iflw`: runtime artifact first (what is running), design-time active version as fallback. */
async function iflowContent(client: CpiClient, id: string, messages: Message[], tenant: Tenant) {
  const sources = [
    ['RUNTIME', `IntegrationRuntimeArtifacts(${literal(id)})/$value`],
    ['DESIGNTIME', `IntegrationDesigntimeArtifacts(Id=${literal(id)},Version='active')/$value`]
  ] as const
  for (const [source, path] of sources) {
    try {
      const archive = await client.download(path)
      const iflw = archive && findIflw(archive)
      if (iflw) return { source, iflw }
    } catch (e) {
      if (!(e instanceof CpiError)) throw e
      messages.push({ tenant, level: 'INFO', message: `${source.toLowerCase()} content not available: ${e.message}` })
    }
  }
  return { source: 'NONE' as const, iflw: undefined }
}

async function externalizedParams(client: CpiClient, id: string): Promise<Map<string, string>> {
  try {
    const list = await client.get(`IntegrationDesigntimeArtifacts(Id=${literal(id)},Version='active')/Configurations`)
    return new Map((list ?? []).map((c: any) => [c.ParameterKey, c.ParameterValue ?? '']))
  } catch (e) {
    if (!(e instanceof CpiError)) throw e
    return new Map()
  }
}

export default class EndpointsService extends cds.ApplicationService {
  async init() {
    this.on('listPackages', guard(async (req: any) => {
      const client = await this.client(req)
      const list = await client.get('IntegrationPackages') ?? []
      return list.map((p: any) => ({ id: p.Id, name: p.Name })).sort((a, b) => a.id.localeCompare(b.id))
    }))

    this.on('listEndpoints', guard(async (req: any) => {
      const client = await this.client(req)
      const tenant = req.data.tenant as Tenant
      const packageId = req.data.packageId?.trim() ?? ''
      const adapter = req.data.adapter?.trim().toLowerCase() ?? ''
      const iflowMatches = anyMatcher(req.data.iflow)
      const urlMatches = anyMatcher(req.data.url)
      const roleMatches = anyMatcher(req.data.role)
      const withRoles = req.data.accessRoles !== false || !!req.data.role?.trim()
      const messages: Message[] = []

      let rows = await tenantEndpoints(client, tenant, messages)
      if (packageId) {
        const ids = await packageIflowIds(client, packageId)
        if (!ids) {
          messages.push({ tenant, level: 'ERROR', message: `Package '${packageId}' not found on ${tenant}` })
          return { endpoints: [], messages }
        }
        rows = rows.filter(r => ids.has(r.iflowId))
      }
      rows = rows.filter(r => iflowMatches(r.iflowName, r.iflowId) && urlMatches(r.url) &&
        (!adapter || r.adapter.toLowerCase() === adapter))
      if (withRoles) {
        await addAccessRoles(client, tenant, rows, messages)
        rows = rows.filter(r => roleMatches(r.userRole))
      }
      const endpoints = rows.sort((a, b) => a.iflowName.localeCompare(b.iflowName) || a.url.localeCompare(b.url))
      return { endpoints, messages }
    }))

    this.on('endpointDetails', guard(async (req: any) => {
      const tenant = req.data.tenant as Tenant
      // older lists may still pass the endpoint ID (`<iflow>$endpointAddress=...`)
      const iflowId: string | undefined = artifactIdFromEndpointId(req.data.iflowId ?? '') || undefined
      const url: string = req.data.url?.trim() ?? ''
      if (!TENANTS.includes(tenant)) req.reject(400, 'tenant must be DEV or PROD')
      if (!iflowId) req.reject(400, 'iflowId is required')
      const client = new CpiClient(await loadConnection(tenant, req))
      const messages: Message[] = []

      const runtime = await runtimeArtifact(client, iflowId!, tenant, messages)
      const deployment = runtime && {
        version: runtime.Version ?? '',
        status: runtime.Status ?? '',
        deployedBy: runtime.DeployedBy ?? '',
        deployedOn: odataDate(runtime.DeployedOn)
      }

      const { source, channels: all } = await senderChannels(client, iflowId!, tenant, messages)
      if (source === 'NONE') {
        messages.push({ tenant, level: 'WARN', message: 'iFlow content could not be downloaded; sender channel unknown' })
        return { deployment, channels: [], matched: false, contentSource: source, messages }
      }
      const matching = all.filter(c => addressMatches(url, c.address))
      if (!all.length) messages.push({ tenant, level: 'WARN', message: 'No sender channel found in the iFlow' })
      else if (!matching.length) messages.push({ tenant, level: 'INFO', message: 'No sender channel address matched the URL; showing all sender channels' })
      if (source === 'DESIGNTIME') messages.push({ tenant, level: 'INFO', message: 'Sender channel read from the design-time (active) version; it may differ from the deployed one' })
      return { deployment, channels: matching.length ? matching : all, matched: matching.length > 0, contentSource: source, messages }
    }))

    return super.init()
  }

  /** Client for `req.data.tenant` (default DEV): 400 for an unknown tenant, 412 when not configured/disabled. */
  private async client(req: any): Promise<CpiClient> {
    const tenant = req.data.tenant ?? 'DEV'
    if (!TENANTS.includes(tenant)) req.reject(400, 'tenant must be DEV or PROD')
    req.data.tenant = tenant
    return new CpiClient(await loadConnection(tenant, req))
  }
}
