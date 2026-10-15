import cds from '@sap/cds'
import { CpiClient, CpiError } from '../../lib/cpi-client.js'
import { loadConnection } from '../../lib/connections.js'
import { ARTIFACT_TYPES, compareItems, summarize, type Item } from './comparator.js'

type Level = 'INFO' | 'WARN' | 'ERROR'
type Env = 'DEV' | 'PROD'

class RunLog {
  entries: { timestamp: string; level: Level; message: string }[] = []
  add(level: Level, message: string) {
    this.entries.push({ timestamp: new Date().toISOString(), level, message })
  }
}

interface PackageContent {
  package?: Item
  artifacts: Item[]
}

async function fetchPackageContent(client: CpiClient, env: Env, packageId: string, log: RunLog): Promise<PackageContent> {
  const safeId = packageId.replace(/'/g, "''")
  const pkg = (await client.get(`IntegrationPackages('${encodeURIComponent(safeId)}')`))?.[0]
  if (!pkg) {
    log.add('WARN', `${env}: package '${packageId}' not found`)
    return { artifacts: [] }
  }
  log.add('INFO', `${env}: package '${packageId}' found, version ${pkg.Version}`)

  const artifacts: Item[] = []
  for (const { entitySet, type } of ARTIFACT_TYPES) {
    const list = await client.get(`IntegrationPackages('${encodeURIComponent(safeId)}')/${entitySet}`)
    if (!list) {
      log.add('WARN', `${env}: ${entitySet} not available`)
      continue
    }
    artifacts.push(...list.map((a: any) => ({ id: a.Id, name: a.Name, type, version: a.Version })))
    log.add('INFO', `${env}: ${list.length} ${type} artifact(s)`)
  }
  return {
    package: { id: pkg.Id, name: pkg.Name, type: 'PACKAGE', version: pkg.Version },
    artifacts
  }
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

export default class VersionComparatorService extends cds.ApplicationService {
  async init() {
    this.on('listPackages', guard(async (req: any) => {
      const [dev, prod] = await this.clients(req)
      const [d, p] = await Promise.all([dev.get('IntegrationPackages'), prod.get('IntegrationPackages')])
      const map = new Map<string, { id: string; name: string; inDev: boolean; inProd: boolean }>()
      for (const [list, flag] of [[d, 'inDev'], [p, 'inProd']] as const) {
        for (const x of list ?? []) {
          const e = map.get(x.Id) ?? { id: x.Id, name: x.Name, inDev: false, inProd: false }
          e[flag] = true
          map.set(x.Id, e)
        }
      }
      return [...map.values()].sort((a, b) => a.id.localeCompare(b.id))
    }))

    this.on('listArtifacts', guard(async (req: any) => {
      const packageId = this.requirePackageId(req)
      const [dev, prod] = await this.clients(req)
      const log = new RunLog()
      const [d, p] = await Promise.all([
        fetchPackageContent(dev, 'DEV', packageId, log),
        fetchPackageContent(prod, 'PROD', packageId, log)
      ])
      const map = new Map<string, { id: string; name: string; type: string; inDev: boolean; inProd: boolean }>()
      for (const [content, flag] of [[d, 'inDev'], [p, 'inProd']] as const) {
        for (const a of content.artifacts) {
          const e = map.get(`${a.type}:${a.id}`) ?? { id: a.id, name: a.name, type: a.type, inDev: false, inProd: false }
          e[flag] = true
          map.set(`${a.type}:${a.id}`, e)
        }
      }
      return [...map.values()].sort((a, b) => a.id.localeCompare(b.id))
    }))

    this.on('compare', async (req: any) => {
      const packageId = this.requirePackageId(req)
      const artifactId: string | undefined = req.data.artifactId?.trim() || undefined
      const [dev, prod] = await this.clients(req)
      const log = new RunLog()
      const empty = { total: 0, matching: 0, mismatching: 0, missingInDev: 0, missingInProd: 0 }

      log.add('INFO', `Comparing ${artifactId ? `artifact '${artifactId}' in ` : ''}package '${packageId}' (DEV vs PROD)`)
      try {
        const d = await fetchPackageContent(dev, 'DEV', packageId, log)
        const p = await fetchPackageContent(prod, 'PROD', packageId, log)
        if (!d.package && !p.package) {
          log.add('ERROR', `Package '${packageId}' exists in neither DEV nor PROD`)
          return { success: false, summary: empty, rows: [], log: log.entries }
        }

        const pick = (c: PackageContent): Item[] =>
          artifactId
            ? c.artifacts.filter(a => a.id === artifactId)
            : [...(c.package ? [c.package] : []), ...c.artifacts]
        const rows = compareItems(packageId, pick(d), pick(p))
        if (artifactId && !rows.length) {
          log.add('ERROR', `Artifact '${artifactId}' not found in package '${packageId}' in DEV or PROD`)
          return { success: false, summary: empty, rows, log: log.entries }
        }

        const summary = summarize(rows)
        log.add(summary.mismatching || summary.missingInDev || summary.missingInProd ? 'WARN' : 'INFO',
          `Done: ${summary.total} item(s), ${summary.matching} match, ${summary.mismatching} differ, ` +
          `${summary.missingInDev} missing in DEV, ${summary.missingInProd} missing in PROD`)
        return { success: true, summary, rows, log: log.entries }
      } catch (e: any) {
        if (!(e instanceof CpiError)) throw e
        log.add('ERROR', e.message)
        return { success: false, summary: empty, rows: [], log: log.entries }
      }
    })

    return super.init()
  }

  private requirePackageId(req: any): string {
    const id = req.data.packageId?.trim()
    if (!id) req.reject(400, 'packageId is required')
    return id
  }

  private async clients(req: any): Promise<[CpiClient, CpiClient]> {
    const [dev, prod] = await Promise.all([loadConnection('DEV', req), loadConnection('PROD', req)])
    return [new CpiClient(dev), new CpiClient(prod)]
  }
}
