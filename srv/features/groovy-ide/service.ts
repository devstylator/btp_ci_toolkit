import cds from '@sap/cds'
import { CpiClient, CpiError } from '../../lib/cpi-client.js'
import { loadConnection } from '../../lib/connections.js'
import { DB_EXECUTOR, EXECUTOR_CODE, ExecutorClient, loadExecutor, type ExecutorConnection } from '../../lib/script-executor.js'
import { readZip } from '../../lib/zip.js'
import { bodiesMatch, buildRequest, isScriptPath, parseResponse, type CompareMode, type NameValue, type RunInput, type RunOutput } from './contract.js'

const { SELECT, INSERT, UPDATE } = cds.ql
const DB_SCRIPTS = 'btp.toolkit.Scripts'
const DB_VERSIONS = 'btp.toolkit.ScriptVersions'
const DB_TEST_CASES = 'btp.toolkit.TestCases'

/** Download sources: artifact type -> CPI entity set. Only DEV is read (decision D13). */
const SOURCES = {
  IFLOW: 'IntegrationDesigntimeArtifacts',
  SCRIPT_COLLECTION: 'ScriptCollectionDesigntimeArtifacts'
} as const
type SourceType = keyof typeof SOURCES

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

function parseList(json: string | null | undefined): NameValue[] {
  if (!json) return []
  try {
    const list = JSON.parse(json)
    return Array.isArray(list) ? list.filter(r => r && typeof r.name === 'string').map(r => ({ name: r.name, value: String(r.value ?? '') })) : []
  } catch {
    return []
  }
}

async function execute(conn: ExecutorConnection, input: RunInput): Promise<RunOutput & { durationMs: number }> {
  const started = Date.now()
  let request
  try {
    request = buildRequest(input)
  } catch (e: any) {
    return { success: false, httpStatus: 0, body: '', headers: [], properties: [], console: '', error: e.message, durationMs: 0 }
  }
  try {
    const res = await new ExecutorClient(conn).post(request)
    return { ...parseResponse(res.status, res.data), durationMs: Date.now() - started }
  } catch (e: any) {
    if (!(e instanceof CpiError)) throw e
    return { success: false, httpStatus: 0, body: '', headers: [], properties: [], console: '', error: e.message, durationMs: Date.now() - started }
  }
}

export default class GroovyIdeService extends cds.ApplicationService {
  async init() {
    this.before(['CREATE', 'UPDATE'], 'Scripts', (req: any) => {
      if ('name' in req.data && !req.data.name?.trim()) req.error(400, 'Name is required', 'name')
      if ('sourceType' in req.data && !['LOCAL', 'IFLOW', 'SCRIPT_COLLECTION'].includes(req.data.sourceType)) {
        req.error(400, 'Unsupported source type', 'sourceType')
      }
    })

    this.before(['CREATE', 'UPDATE'], 'TestCases', (req: any) => {
      if ('name' in req.data && !req.data.name?.trim()) req.error(400, 'Name is required', 'name')
      if (req.data.compareMode && !['EXACT', 'TRIMMED', 'JSON', 'XML'].includes(req.data.compareMode)) {
        req.error(400, 'Unsupported compare mode', 'compareMode')
      }
      for (const f of ['headers', 'properties']) {
        const v = req.data[f]
        if (v && !Array.isArray((() => { try { return JSON.parse(v) } catch { return null } })())) {
          req.error(400, `${f} must be a JSON array of {name, value}`, f)
        }
      }
    })

    this.on('saveVersion', 'Scripts', async (req: any) => {
      const ID = req.params[0]?.ID ?? req.params[0]
      const script = await SELECT.one.from(DB_SCRIPTS).columns('ID', 'content').where({ ID })
      if (!script) return req.reject(404, 'Script not found')
      const content = req.data.content ?? script.content ?? ''
      if (req.data.content != null) await UPDATE.entity(DB_SCRIPTS).set({ content }).where({ ID })
      const last = await SELECT.one.from(DB_VERSIONS).columns('max(version) as version').where({ script_ID: ID })
      const version = { ID: cds.utils.uuid(), script_ID: ID, version: (last?.version ?? 0) + 1, comment: req.data.comment?.trim() || null, content }
      await INSERT.into(DB_VERSIONS).entries(version)
      req.notify(`Version ${version.version} saved`)
      return SELECT.one.from(DB_VERSIONS).where({ ID: version.ID })
    })

    this.on('executorStatus', async (req: any) => {
      const row = await SELECT.one.from(DB_EXECUTOR).columns('enabled').where({ code: EXECUTOR_CODE })
      return { enabled: !!row?.enabled, canRun: req.user.is('Developer') }
    })

    this.on('listPackages', guard(async (req: any) => {
      const list = await (await this.dev(req)).get('IntegrationPackages') ?? []
      return list.map((p: any) => ({ id: p.Id, name: p.Name })).sort((a, b) => a.id.localeCompare(b.id))
    }))

    this.on('listArtifacts', guard(async (req: any) => {
      const packageId = this.required(req, 'packageId')
      const dev = await this.dev(req)
      const out: { id: string; name: string; type: SourceType; version: string }[] = []
      for (const [type, entitySet] of Object.entries(SOURCES) as [SourceType, string][]) {
        const list = await dev.get(`IntegrationPackages(${literal(packageId)})/${entitySet}`)
        out.push(...(list ?? []).map((a: any) => ({ id: a.Id, name: a.Name, type, version: a.Version })))
      }
      return out.sort((a, b) => a.name.localeCompare(b.name))
    }))

    this.on('listArtifactScripts', guard(async (req: any) => {
      const packageId = this.required(req, 'packageId')
      const artifactId = this.required(req, 'artifactId')
      const type = req.data.type as SourceType
      if (!(type in SOURCES)) return req.reject(400, 'type must be IFLOW or SCRIPT_COLLECTION')
      const dev = await this.dev(req)
      // Name/version come from the package listing: CPI answers a single-artifact GET with HTTP 501.
      const list = await dev.get(`IntegrationPackages(${literal(packageId)})/${SOURCES[type]}`)
      const meta = list?.find((a: any) => a.Id === artifactId)
      const zip = meta && await dev.download(`${SOURCES[type]}(Id=${literal(artifactId)},Version='active')/$value`)
      if (!meta || !zip) return req.reject(404, `Artifact '${artifactId}' not found in DEV`)
      let scripts
      try {
        scripts = readZip(zip).filter(e => isScriptPath(e.path))
          .map(e => ({ path: e.path, content: e.read().toString('utf8') }))
          .sort((a, b) => a.path.localeCompare(b.path))
      } catch (e: any) {
        return req.reject(502, `Artifact download could not be read: ${e.message}`)
      }
      return { packageId, artifactId, artifactName: meta.Name, type, version: meta.Version, scripts }
    }))

    this.on('run', async (req: any) => {
      const script = req.data.script
      if (!script?.trim()) return req.reject(400, 'script is required')
      return execute(await loadExecutor(req), {
        script, payload: req.data.payload, headers: req.data.headers, properties: req.data.properties
      })
    })

    this.on('runTests', async (req: any) => {
      const scriptId = this.required(req, 'scriptId')
      const ids: string[] = req.data.testCaseIds ?? []
      const conn = await loadExecutor(req)
      const saved = await SELECT.one.from(DB_SCRIPTS).columns('content').where({ ID: scriptId })
      if (!saved) return req.reject(404, 'Script not found')
      const script = req.data.script ?? saved.content
      if (!script?.trim()) return req.reject(400, 'script is required')

      const query = SELECT.from(DB_TEST_CASES).where({ script_ID: scriptId }).orderBy('name')
      const cases = (await query).filter((c: any) => !ids.length || ids.includes(c.ID))
      const results = []
      for (const tc of cases) {   // sequential: keeps the load on the runner predictable
        const result = await execute(conn, {
          script, payload: tc.payload, headers: parseList(tc.headers), properties: parseList(tc.properties)
        })
        const status = !result.success ? 'ERROR'
          : tc.expectedBody == null || tc.expectedBody === '' ? 'NO_EXPECTATION'
            : bodiesMatch(result.body, tc.expectedBody, (tc.compareMode ?? 'TRIMMED') as CompareMode) ? 'PASSED' : 'FAILED'
        results.push({ testCaseId: tc.ID, name: tc.name, status, result })
      }
      return results
    })

    return super.init()
  }

  private required(req: any, name: string): string {
    const value = req.data[name]?.trim()
    if (!value) req.reject(400, `${name} is required`)
    return value
  }

  private async dev(req: any): Promise<CpiClient> {
    return new CpiClient(await loadConnection('DEV', req))
  }
}
