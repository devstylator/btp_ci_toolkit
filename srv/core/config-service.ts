import cds from '@sap/cds'
import { encrypt } from '../lib/crypto.js'
import { CpiClient, CpiError } from '../lib/cpi-client.js'
import { loadConnection } from '../lib/connections.js'
import { isAllowedUrl } from '../lib/urls.js'
import { DB_EXECUTOR, ensureExecutorRow, ExecutorClient, loadExecutor } from '../lib/script-executor.js'
import { buildRequest, parseResponse } from '../features/groovy-ide/contract.js'

const { SELECT, UPDATE } = cds.ql
const DB_CONNECTIONS = 'btp.toolkit.Connections'
const URL_FIELDS = ['tenantUrl', 'tokenUrl', 'endpointUrl']
const TABLES: Record<string, string> = { Connections: DB_CONNECTIONS, ScriptExecutor: DB_EXECUTOR }
/** DB table behind a request target (active or draft entity). */
const tableOf = (req: any) => TABLES[req.target.name.replace(/\.drafts$/, '').split('.').pop()]
const TEST_BODY = 'BTP CI Toolkit executor test'
const TEST_SCRIPT = `import com.sap.gateway.ip.core.customdev.util.Message
Message processData(Message message) {
  message.setBody('${TEST_BODY}')
  return message
}`

export default class ConfigService extends cds.ApplicationService {
  async init() {
    this.on('READ', 'ConnectionModes', () => [
      { code: 'DIRECT', name: 'Direct credentials' },
      { code: 'DESTINATION', name: 'BTP Destination' }
    ])
    this.before('UPDATE', ['Connections', 'ScriptExecutor'], (req: any) => {
      for (const f of URL_FIELDS) {
        const v = req.data[f]
        if (v && !isAllowedUrl(v)) req.error(400, `${f} must be a valid https:// URL (http://localhost allowed locally)`, f)
      }
      if ('connectionMode' in req.data && !['DIRECT', 'DESTINATION'].includes(req.data.connectionMode)) {
        req.error(400, 'Unsupported connection mode', 'connectionMode')
      }
    })

    // Validate the complete draft on save, rather than rejecting intermediate edits.
    this.before('SAVE', ['Connections', 'ScriptExecutor'], (req: any) => {
      // Draft PATCHes do not pass the UPDATE handler above, so URLs are checked again on activation.
      for (const f of URL_FIELDS) {
        const v = req.data[f]
        if (v && !isAllowedUrl(v)) req.error(400, `${f} must be a valid https:// URL (http://localhost allowed locally)`, f)
      }
      if (req.data.connectionMode === 'DESTINATION' && !req.data.destinationName?.trim()) {
        req.error(400, 'Destination name is required in BTP Destination mode', 'destinationName')
      }
    })

    this.on('setSecret', ['Connections', 'ScriptExecutor'], async (req: any) => {
      const table = tableOf(req)
      const code = req.params[0]?.code ?? req.params[0]
      const secret = req.data.secret
      const row = await SELECT.one.from(table).columns('connectionMode').where({ code })
      if (row?.connectionMode === 'DESTINATION') return req.reject(400, 'Manage these credentials in BTP Destinations')
      if (!secret) return req.reject(400, 'secret must not be empty')
      await UPDATE.entity(table).set({ clientSecretEnc: encrypt(secret) }).where({ code })
      req.notify('Client secret saved')
      return true
    })

    // The executor row is not seeded (HDI table data would reset it on redeploy); create it on first read.
    this.before('READ', 'ScriptExecutor', () => ensureExecutorRow())

    this.after('READ', ['Connections', 'ScriptExecutor'], async (rows: any, req: any) => {
      const list = (Array.isArray(rows) ? rows : [rows]).filter(Boolean)
      if (!list.length) return
      const stored = await SELECT.from(tableOf(req)).columns('code', 'clientSecretEnc')
      const withSecret = new Set(stored.filter((r: any) => r.clientSecretEnc).map((r: any) => r.code))
      for (const r of list) r.secretSet = withSecret.has(r.code)
    })

    this.on('test', 'Connections', async (req: any) => {
      const code = req.params[0]?.code ?? req.params[0]
      const conn = await loadConnection(code, req)
      let ok = true
      let message = 'Connection successful'
      try {
        const packages = await new CpiClient(conn).get('IntegrationPackages?$top=1')
        if (!packages) throw new CpiError('CPI package API not found (HTTP 404)', 404)
      } catch (e: any) {
        ok = false
        message = e.message
      }
      await UPDATE.entity(DB_CONNECTIONS)
        .set({ lastTestAt: new Date().toISOString(), lastTestOk: ok, lastTestMessage: message.slice(0, 500) })
        .where({ code })
      if (ok) req.notify(message)
      else req.warn(message)
      return { ok, message }
    })

    this.on('test', 'ScriptExecutor', async (req: any) => {
      const code = req.params[0]?.code ?? req.params[0]
      const conn = await loadExecutor(req)
      let ok = false
      let message: string
      try {
        const res = await new ExecutorClient(conn).post(buildRequest({ script: TEST_SCRIPT }))
        const out = parseResponse(res.status, res.data)
        ok = out.success && out.body === TEST_BODY
        message = ok ? 'Test script executed successfully'
          : out.error ? `Test script failed: ${out.error}` : 'Runner responded, but the test script result was not returned'
      } catch (e: any) {
        if (!(e instanceof CpiError)) throw e
        message = e.message
      }
      await UPDATE.entity(DB_EXECUTOR)
        .set({ lastTestAt: new Date().toISOString(), lastTestOk: ok, lastTestMessage: message.slice(0, 500) })
        .where({ code })
      if (ok) req.notify(message)
      else req.warn(message)
      return { ok, message }
    })

    return super.init()
  }
}
