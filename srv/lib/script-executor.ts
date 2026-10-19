import cds from '@sap/cds'
import { type HttpDestination } from '@sap-cloud-sdk/connectivity'
import { executeHttpRequest } from '@sap-cloud-sdk/http-client'
import { decrypt } from './crypto.js'
import { clientCredentialsToken, CpiError, lookupDestination } from './http-auth.js'
import { isAllowedUrl } from './urls.js'

const { SELECT, INSERT } = cds.ql

export const DB_EXECUTOR = 'btp.toolkit.ScriptExecutor'
export const EXECUTOR_CODE = 'DEFAULT'
const RUN_TIMEOUT_MS = 60_000

export type ExecutorConnection = {
  connectionMode: 'DIRECT'
  endpointUrl: string
  tokenUrl: string
  clientId: string
  clientSecret: string
} | {
  connectionMode: 'DESTINATION'
  destinationName: string
}

/** The single executor row; created on first access so no seed data (and no HDI table data) is needed. */
export async function ensureExecutorRow(): Promise<void> {
  const row = await SELECT.one.from(DB_EXECUTOR).columns('code').where({ code: EXECUTOR_CODE })
  if (row) return
  try {
    await INSERT.into(DB_EXECUTOR).entries({ code: EXECUTOR_CODE, connectionMode: 'DIRECT', enabled: false })
  } catch (e) {
    // a concurrent first read may have created it already
    if (!await SELECT.one.from(DB_EXECUTOR).columns('code').where({ code: EXECUTOR_CODE })) throw e
  }
}

/** Loads the executor settings (with decrypted secret). Rejects with 412 when it is not usable. */
export async function loadExecutor(req: { reject: (status: number, msg: string) => never }): Promise<ExecutorConnection> {
  const row = await SELECT.one.from(DB_EXECUTOR).where({ code: EXECUTOR_CODE })
  if (!row?.enabled) req.reject(412, 'The script executor is not enabled (Configuration > Script executor)')
  if (row.connectionMode === 'DESTINATION') {
    if (!row.destinationName?.trim()) req.reject(412, 'The script executor requires a destination name')
    return { connectionMode: 'DESTINATION', destinationName: row.destinationName.trim() }
  }
  if (!row.endpointUrl || !row.tokenUrl || !row.clientId || !row.clientSecretEnc) {
    req.reject(412, 'The script executor is not fully configured (endpoint URL, token URL, client ID and secret are required)')
  }
  if (!isAllowedUrl(row.endpointUrl) || !isAllowedUrl(row.tokenUrl)) req.reject(412, 'The script executor has an invalid URL')
  return {
    connectionMode: 'DIRECT',
    endpointUrl: row.endpointUrl,
    tokenUrl: row.tokenUrl,
    clientId: row.clientId,
    clientSecret: decrypt(row.clientSecretEnc)
  }
}

/**
 * Posts a request to the script-runner iFlow. Not a CPI design-time change, so it is not routed through
 * `CpiClient.write`; access is controlled by the Developer role and the executor's `enabled` flag.
 */
export class ExecutorClient {
  constructor(private readonly conn: ExecutorConnection) {}

  async post(body: unknown): Promise<{ status: number; data: unknown }> {
    let destination: HttpDestination
    const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json' }
    if (this.conn.connectionMode === 'DIRECT') {
      destination = { url: this.conn.endpointUrl, authentication: 'NoAuthentication' }
      headers.Authorization = `Bearer ${await clientCredentialsToken(this.conn)}`
    } else {
      destination = await lookupDestination(this.conn.destinationName, 'the script executor')
    }
    try {
      const res = await executeHttpRequest(destination, {
        method: 'POST', data: body, headers, timeout: RUN_TIMEOUT_MS, maxRedirects: 0,
        validateStatus: () => true, responseType: 'text', transformResponse: [(d: unknown) => d]
      }, { fetchCsrfToken: false })
      return { status: res.status, data: res.data }
    } catch {
      throw new CpiError('Script executor call failed (authentication, connection error or timeout)')
    }
  }
}
