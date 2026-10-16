import cds from '@sap/cds'
import { decrypt } from './crypto.js'
import type { CpiConnection } from './cpi-client.js'
import { isAllowedUrl } from './urls.js'

const { SELECT } = cds.ql

/** Loads a configured connection (with decrypted secret). Rejects with 412 when it is not usable. */
export async function loadConnection(code: 'DEV' | 'PROD', req: { reject: (status: number, msg: string) => never }): Promise<CpiConnection> {
  const row = await SELECT.one.from('btp.toolkit.Connections').where({ code })
  if (!row) req.reject(404, `Connection ${code} does not exist`)
  if (!row.enabled) req.reject(412, `Connection ${code} is disabled`)
  const mode = row.connectionMode ?? 'DIRECT'
  if (mode === 'DESTINATION') {
    if (!row.destinationName?.trim()) req.reject(412, `Connection ${code} requires a destination name`)
    return { code, connectionMode: 'DESTINATION', destinationName: row.destinationName.trim() }
  }
  if (mode !== 'DIRECT') req.reject(412, `Connection ${code} has an unsupported connection mode`)
  if (!row.tenantUrl || !row.tokenUrl || !row.clientId || !row.clientSecretEnc) {
    req.reject(412, `Connection ${code} is not fully configured (tenant URL, token URL, client ID and secret are required)`)
  }
  if (!isAllowedUrl(row.tenantUrl) || !isAllowedUrl(row.tokenUrl)) req.reject(412, `Connection ${code} has an invalid URL`)
  return {
    code,
    connectionMode: 'DIRECT',
    tenantUrl: row.tenantUrl,
    tokenUrl: row.tokenUrl,
    clientId: row.clientId,
    clientSecret: decrypt(row.clientSecretEnc)
  }
}

/** Check active settings for every CPI write, including clients created before settings changed. */
export async function assertConnectionWritable(code: string): Promise<void> {
  const row = await SELECT.one.from('btp.toolkit.Connections').columns('enabled', 'allowModifications').where({ code })
  if (!row?.enabled || row.allowModifications !== true) {
    throw Object.assign(new Error(`CPI modifications are disabled for ${code}`), { statusCode: 403 })
  }
}
