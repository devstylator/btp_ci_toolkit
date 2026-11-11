/**
 * Version Comparator: lists the DEV packages; `compare` reads all artifacts of one package in DEV and PROD and
 * compares their version numbers. Nothing is persisted - the result (including a step log) is returned.
 */
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
  package?: { id: string; name: string; description: string }
  artifacts: Item[]
}

const description = (p: any): string => p.ShortText || p.Description || ''

async function fetchPackageContent(client: CpiClient, env: Env, packageId: string, log: RunLog): Promise<PackageContent> {
  const path = `IntegrationPackages('${encodeURIComponent(packageId.replace(/'/g, "''"))}')`
  const pkg = (await client.get(path))?.[0]
  if (!pkg) {
    log.add('WARN', `${env}: package '${packageId}' not found`)
    return { artifacts: [] }
  }
  log.add('INFO', `${env}: package '${packageId}' found`)

  const lists = await Promise.all(ARTIFACT_TYPES.map(({ entitySet }) => client.get(`${path}/${entitySet}`)))
  const artifacts: Item[] = []
  ARTIFACT_TYPES.forEach(({ entitySet, type }, i) => {
    const list = lists[i]
    if (!list) {
      log.add('WARN', `${env}: ${entitySet} not available`)
      return
    }
    artifacts.push(...list.map((a: any) => ({ id: a.Id, name: a.Name, type, version: a.Version })))
    log.add('INFO', `${env}: ${list.length} ${type} artifact(s)`)
  })
  return { package: { id: pkg.Id, name: pkg.Name, description: description(pkg) }, artifacts }
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
      const dev = new CpiClient(await loadConnection('DEV', req))
      const list = await dev.get('IntegrationPackages') ?? []
      return list
        .map((p: any) => ({ id: p.Id, name: p.Name, description: description(p) }))
        .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id))
    }))

    this.on('compare', async (req: any) => {
      const packageId = req.data.packageId?.trim()
      if (!packageId) return req.reject(400, 'packageId is required')
      const [dev, prod] = await this.clients(req)
      const log = new RunLog()
      const empty = { total: 0, matching: 0, mismatching: 0, missingInDev: 0, missingInProd: 0 }
      const header = { id: packageId, name: packageId, description: '', inDev: false, inProd: false }

      log.add('INFO', `Comparing package '${packageId}' (DEV vs PROD)`)
      try {
        // both tenants in parallel, with separate logs so the merged log stays readable
        const devLog = new RunLog()
        const prodLog = new RunLog()
        const [d, p] = await Promise.all([
          fetchPackageContent(dev, 'DEV', packageId, devLog),
          fetchPackageContent(prod, 'PROD', packageId, prodLog)
        ])
        log.entries.push(...devLog.entries, ...prodLog.entries)
        const ref = d.package ?? p.package
        const pkg = { ...header, ...ref, inDev: !!d.package, inProd: !!p.package }
        if (!ref) {
          log.add('ERROR', `Package '${packageId}' exists in neither DEV nor PROD`)
          return { success: false, package: pkg, summary: empty, rows: [], log: log.entries }
        }

        const rows = compareItems(packageId, d.artifacts, p.artifacts)
        const summary = summarize(rows)
        log.add(summary.mismatching || summary.missingInDev || summary.missingInProd ? 'WARN' : 'INFO',
          `Done: ${summary.total} artifact(s), ${summary.matching} match, ${summary.mismatching} differ, ` +
          `${summary.missingInDev} missing in DEV, ${summary.missingInProd} missing in PROD`)
        return { success: true, package: pkg, summary, rows, log: log.entries }
      } catch (e: any) {
        if (!(e instanceof CpiError)) throw e
        log.add('ERROR', e.message)
        return { success: false, package: header, summary: empty, rows: [], log: log.entries }
      }
    })

    return super.init()
  }

  private async clients(req: any): Promise<[CpiClient, CpiClient]> {
    const [dev, prod] = await Promise.all([loadConnection('DEV', req), loadConnection('PROD', req)])
    return [new CpiClient(dev), new CpiClient(prod)]
  }
}
