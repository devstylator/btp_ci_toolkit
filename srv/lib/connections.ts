import cds from '@sap/cds'
import { decrypt } from './crypto.js'
import type { CpiConnection } from './cpi-client.js'

const { SELECT } = cds.ql

/** Loads a configured connection (with decrypted secret). Rejects with 412 when it is not usable. */
export async function loadConnection(code: 'DEV' | 'PROD', req: { reject: (status: number, msg: string) => never }): Promise<CpiConnection> {
  const row = await SELECT.one.from('btp.toolkit.Connections').where({ code })
  if (!row) req.reject(404, `Connection ${code} does not exist`)
  if (!row.enabled) req.reject(412, `Connection ${code} is disabled`)
  if (!row.tenantUrl || !row.tokenUrl || !row.clientId || !row.clientSecretEnc) {
    req.reject(412, `Connection ${code} is not fully configured (tenant URL, token URL, client ID and secret are required)`)
  }
  return {
    code,
    tenantUrl: row.tenantUrl,
    tokenUrl: row.tokenUrl,
    clientId: row.clientId,
    clientSecret: decrypt(row.clientSecretEnc)
  }
}
