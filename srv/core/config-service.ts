import cds from '@sap/cds'
import { encrypt } from '../lib/crypto.js'
import { CpiClient, CpiError } from '../lib/cpi-client.js'
import { loadConnection } from '../lib/connections.js'
import { isAllowedUrl } from '../lib/urls.js'

const { SELECT, UPDATE } = cds.ql
const DB_CONNECTIONS = 'btp.toolkit.Connections'
const URL_FIELDS = ['tenantUrl', 'tokenUrl']

export default class ConfigService extends cds.ApplicationService {
  async init() {
    this.on('READ', 'ConnectionModes', () => [
      { code: 'DIRECT', name: 'Direct credentials' },
      { code: 'DESTINATION', name: 'BTP Destination' }
    ])
    this.before('UPDATE', 'Connections', (req: any) => {
      for (const f of URL_FIELDS) {
        const v = req.data[f]
        if (v && !isAllowedUrl(v)) req.error(400, `${f} must be a valid https:// URL (http://localhost allowed locally)`, f)
      }
      if ('connectionMode' in req.data && !['DIRECT', 'DESTINATION'].includes(req.data.connectionMode)) {
        req.error(400, 'Unsupported connection mode', 'connectionMode')
      }
    })

    // Validate the complete draft on save, rather than rejecting intermediate edits.
    this.before('SAVE', 'Connections', (req: any) => {
      if (req.data.connectionMode === 'DESTINATION' && !req.data.destinationName?.trim()) {
        req.error(400, 'Destination name is required in BTP Destination mode', 'destinationName')
      }
    })

    this.on('setSecret', 'Connections', async (req: any) => {
      const code = req.params[0]?.code ?? req.params[0]
      const secret = req.data.secret
      const row = await SELECT.one.from(DB_CONNECTIONS).columns('connectionMode').where({ code })
      if (row?.connectionMode === 'DESTINATION') return req.reject(400, 'Manage this connection’s credentials in BTP Destinations')
      if (!secret) return req.reject(400, 'secret must not be empty')
      await UPDATE.entity(DB_CONNECTIONS).set({ clientSecretEnc: encrypt(secret) }).where({ code })
      req.notify('Client secret saved')
      return true
    })

    this.after('READ', 'Connections', async (rows: any) => {
      const list = (Array.isArray(rows) ? rows : [rows]).filter(Boolean)
      if (!list.length) return
      const stored = await SELECT.from(DB_CONNECTIONS).columns('code', 'clientSecretEnc')
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

    return super.init()
  }
}
