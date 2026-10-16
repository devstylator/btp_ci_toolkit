import cds from '@sap/cds'
import { encrypt } from '../lib/crypto.js'
import { CpiClient } from '../lib/cpi-client.js'
import { loadConnection } from '../lib/connections.js'

const { SELECT, UPDATE } = cds.ql
const DB_CONNECTIONS = 'btp.toolkit.Connections'
const URL_FIELDS = ['tenantUrl', 'tokenUrl']

export default class ConfigService extends cds.ApplicationService {
  async init() {
    this.before('UPDATE', 'Connections', (req: any) => {
      for (const f of URL_FIELDS) {
        const v = req.data[f]
        if (v && !/^(https:\/\/|http:\/\/localhost[:/])[^\s]+/i.test(v)) req.error(400, `${f} must be a valid https:// URL`, f)
      }
    })

    this.on('setSecret', 'Connections', async (req: any) => {
      const code = req.params[0]?.code ?? req.params[0]
      const secret = req.data.secret
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
        await new CpiClient(conn).get('IntegrationPackages?$top=1')
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
