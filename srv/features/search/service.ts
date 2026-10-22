import cds from '@sap/cds'
import { CpiClient, CpiError } from '../../lib/cpi-client.js'
import { loadConnection } from '../../lib/connections.js'
import { readZip } from '../../lib/zip.js'
import { isScriptPath } from '../groovy-ide/contract.js'
import { scanGroovy } from './groovy.js'
import { matcher } from './pattern.js'

type Tenant = 'DEV' | 'PROD'
type Level = 'INFO' | 'WARN' | 'ERROR'
type ArtifactType = 'IFLOW' | 'SCRIPT_COLLECTION'

const TENANTS: Tenant[] = ['DEV', 'PROD']
const ENTITY_SETS: Record<ArtifactType, string> = {
  IFLOW: 'IntegrationDesigntimeArtifacts',
  SCRIPT_COLLECTION: 'ScriptCollectionDesigntimeArtifacts'
}
/** Parallel CPI requests per search; keeps a tenant-wide search fast without flooding the tenant. */
const CONCURRENCY = 6
const MAX_FINDINGS = 5000

const literal = (value: string) => `'${encodeURIComponent(value.replace(/'/g, "''"))}'`

class RunLog {
  entries: { timestamp: string; level: Level; message: string }[] = []
  add(level: Level, message: string) {
    this.entries.push({ timestamp: new Date().toISOString(), level, message })
  }
}

interface Artifact {
  type: ArtifactType
  id: string
  name: string
  version: string
  packageId: string
  packageName: string
}

/** Turns CPI call failures into 502 responses. */
const guard = (fn: (req: any) => Promise<any>) => async (req: any) => {
  try {
    return await fn(req)
  } catch (e) {
    if (e instanceof CpiError) req.reject(502, e.message)
    throw e
  }
}

/** Runs `fn` for all items with at most `limit` calls in flight. */
async function eachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++])
  }))
}

export default class SearchService extends cds.ApplicationService {
  async init() {
    this.on('listPackages', guard(async (req: any) => {
      const client = await this.client(req)
      const list = await client.get('IntegrationPackages') ?? []
      return list.map((p: any) => ({ id: p.Id, name: p.Name })).sort((a, b) => a.id.localeCompare(b.id))
    }))

    this.on('search', async (req: any) => {
      const { packageId, name, value, caseSensitive } = req.data
      const iflows = req.data.iflows !== false
      const scripts = req.data.scripts !== false
      if (!name?.trim() && !value?.trim()) return req.reject(400, 'Enter a name and/or a value to search for')
      if (!iflows && !scripts) return req.reject(400, 'Select at least one object type (iFlows, scripts)')
      const client = await this.client(req)
      const matches = matcher({ name: name?.trim(), value: value?.trim(), caseSensitive: !!caseSensitive })
      const log = new RunLog()
      const findings: any[] = []
      const summary = { packages: 0, artifacts: 0, scripts: 0, findings: 0, failures: 0, truncated: false }
      const result = (success: boolean) => {
        summary.findings = findings.length
        findings.sort((a, b) => a.packageId.localeCompare(b.packageId) || a.artifactName.localeCompare(b.artifactName) ||
          a.objectType.localeCompare(b.objectType) || a.scriptPath.localeCompare(b.scriptPath) || a.line - b.line ||
          a.name.localeCompare(b.name))
        return { success, summary, findings, log: log.entries }
      }
      const push = (finding: any) => {
        if (findings.length < MAX_FINDINGS) findings.push(finding)
        else summary.truncated = true
      }

      log.add('INFO', `Searching ${req.data.tenant}${packageId ? ` package '${packageId}'` : ' (all packages)'} for ` +
        [name?.trim() && `name '${name.trim()}'`, value?.trim() && `value '${value.trim()}'`].filter(Boolean).join(' and ') +
        ` in ${[iflows && 'iFlow parameters', scripts && 'scripts'].filter(Boolean).join(' and ')}` +
        `${caseSensitive ? ' (case sensitive)' : ''}`)

      let packages: { Id: string; Name: string }[]
      try {
        packages = packageId?.trim()
          ? await client.get(`IntegrationPackages(${literal(packageId.trim())})`) ?? []
          : await client.get('IntegrationPackages') ?? []
      } catch (e) {
        if (!(e instanceof CpiError)) throw e
        log.add('ERROR', `Packages could not be read: ${e.message}`)
        return result(false)
      }
      if (!packages.length) {
        log.add('ERROR', packageId?.trim() ? `Package '${packageId.trim()}' not found` : 'No packages found')
        return result(false)
      }
      summary.packages = packages.length

      // artifacts of all packages
      const types: ArtifactType[] = scripts ? ['IFLOW', 'SCRIPT_COLLECTION'] : ['IFLOW']
      const artifacts: Artifact[] = []
      await eachLimit(packages.flatMap(p => types.map(type => ({ p, type }))), CONCURRENCY, async ({ p, type }) => {
        try {
          const list = await client.get(`IntegrationPackages(${literal(p.Id)})/${ENTITY_SETS[type]}`)
          if (!list) return log.add('WARN', `${p.Id}: ${ENTITY_SETS[type]} not available`)
          artifacts.push(...list.map((a: any) => ({
            type, id: a.Id, name: a.Name ?? a.Id, version: a.Version ?? '', packageId: p.Id, packageName: p.Name ?? p.Id
          })))
        } catch (e) {
          if (!(e instanceof CpiError)) throw e
          summary.failures++
          log.add('WARN', `${p.Id}: ${ENTITY_SETS[type]} could not be read (${e.message})`)
        }
      })
      summary.artifacts = artifacts.length
      log.add('INFO', `${packages.length} package(s), ${artifacts.filter(a => a.type === 'IFLOW').length} iFlow(s)` +
        (scripts ? `, ${artifacts.filter(a => a.type === 'SCRIPT_COLLECTION').length} Script Collection(s)` : ''))

      const base = (a: Artifact) => ({
        packageId: a.packageId, packageName: a.packageName, artifactId: a.id, artifactName: a.name,
        artifactType: a.type, version: a.version
      })
      const key = (a: Artifact) => `Id=${literal(a.id)},Version='active'`

      await eachLimit(artifacts, CONCURRENCY, async a => {
        if (iflows && a.type === 'IFLOW') {
          try {
            for (const c of await client.get(`${ENTITY_SETS.IFLOW}(${key(a)})/Configurations`) ?? []) {
              const f = { name: c.ParameterKey ?? '', value: c.ParameterValue ?? '' }
              if (matches(f)) {
                push({ ...base(a), ...f, objectType: 'IFLOW', kind: 'PARAMETER', dataType: c.DataType ?? '', scriptPath: '', line: 0 })
              }
            }
          } catch (e) {
            if (!(e instanceof CpiError)) throw e
            summary.failures++
            log.add('WARN', `${a.packageId} / ${a.name}: configuration could not be read (${e.message})`)
          }
        }
        if (!scripts) return
        try {
          const zip = await client.download(`${ENTITY_SETS[a.type]}(${key(a)})/$value`)
          if (!zip) return log.add('WARN', `${a.packageId} / ${a.name}: content not found`)
          for (const entry of readZip(zip).filter(e => isScriptPath(e.path))) {
            summary.scripts++
            for (const f of scanGroovy(entry.read().toString('utf8'))) {
              if (matches(f)) {
                push({ ...base(a), ...f, objectType: 'SCRIPT', dataType: '', scriptPath: entry.path })
              }
            }
          }
        } catch (e: any) {
          summary.failures++
          log.add('WARN', `${a.packageId} / ${a.name}: scripts could not be read (${e instanceof CpiError ? e.message : `invalid archive: ${e.message}`})`)
        }
      })

      if (scripts) log.add('INFO', `${summary.scripts} script(s) scanned`)
      if (summary.truncated) log.add('WARN', `More than ${MAX_FINDINGS} findings; only the first ${MAX_FINDINGS} are returned, refine the search`)
      log.add(summary.failures ? 'WARN' : 'INFO', `Done: ${findings.length} finding(s)` +
        (summary.failures ? `, ${summary.failures} object(s) could not be read` : ''))
      return result(true)
    })

    return super.init()
  }

  private async client(req: any): Promise<CpiClient> {
    const tenant = req.data.tenant ?? 'DEV'
    if (!TENANTS.includes(tenant)) req.reject(400, 'tenant must be DEV or PROD')
    req.data.tenant = tenant
    return new CpiClient(await loadConnection(tenant, req))
  }
}
