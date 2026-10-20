import cds from '@sap/cds'
import { CpiClient, CpiError } from '../../lib/cpi-client.js'
import { loadConnection } from '../../lib/connections.js'
import { adapterFromUrl, addressMatches, artifactIdFromEndpointId, findIflw, odataDate, parseSenderChannels, toSenderChannels } from './iflow.js'

type Tenant = 'DEV' | 'PROD'
type Level = 'INFO' | 'WARN' | 'ERROR'
interface Message { tenant: Tenant; level: Level; message: string }

const TENANTS: Tenant[] = ['DEV', 'PROD']
const literal = (value: string) => `'${encodeURIComponent(value.replace(/'/g, "''"))}'`

/** Request stand-in for `loadConnection` that throws instead of rejecting, so one tenant can be skipped. */
const softReq = { reject: (status: number, message: string): never => { throw Object.assign(new Error(message), { status }) } }

/** Turns CPI call failures into 502 responses. */
const guard = (fn: (req: any) => Promise<any>) => async (req: any) => {
  try {
    return await fn(req)
  } catch (e) {
    if (e instanceof CpiError) req.reject(502, e.message)
    throw e
  }
}

async function tenantEndpoints(tenant: Tenant, messages: Message[]) {
  let client: CpiClient
  try {
    client = new CpiClient(await loadConnection(tenant, softReq))
  } catch (e: any) {
    messages.push({ tenant, level: 'WARN', message: `${tenant} skipped: ${e.message}` })
    return []
  }
  try {
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
        version: artifact?.Version ?? ep.Version ?? ''
      }))
    })
  } catch (e) {
    if (!(e instanceof CpiError)) throw e
    messages.push({ tenant, level: 'ERROR', message: `${tenant}: ${e.message}` })
    return []
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
    this.on('listEndpoints', async () => {
      const messages: Message[] = []
      const lists = await Promise.all(TENANTS.map(t => tenantEndpoints(t, messages)))
      const endpoints = lists.flat().sort((a, b) =>
        a.iflowName.localeCompare(b.iflowName) || a.tenant.localeCompare(b.tenant) || a.url.localeCompare(b.url))
      return { endpoints, messages }
    })

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

      const { source, iflw } = await iflowContent(client, iflowId!, messages, tenant)
      if (!iflw) {
        messages.push({ tenant, level: 'WARN', message: 'iFlow content could not be downloaded; sender channel unknown' })
        return { deployment, channels: [], matched: false, contentSource: source, messages }
      }
      const parsed = parseSenderChannels(iflw)
      const needsParams = parsed.some(c => [...c.props.values()].some(v => v.includes('{{')))
      const all = toSenderChannels(parsed, needsParams ? await externalizedParams(client, iflowId!) : new Map())
      const matching = all.filter(c => addressMatches(url, c.address))
      if (!all.length) messages.push({ tenant, level: 'WARN', message: 'No sender channel found in the iFlow' })
      else if (!matching.length) messages.push({ tenant, level: 'INFO', message: 'No sender channel address matched the URL; showing all sender channels' })
      if (source === 'DESIGNTIME') messages.push({ tenant, level: 'INFO', message: 'Sender channel read from the design-time (active) version; it may differ from the deployed one' })
      return { deployment, channels: matching.length ? matching : all, matched: matching.length > 0, contentSource: source, messages }
    }))

    return super.init()
  }
}
