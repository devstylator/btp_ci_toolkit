import { createHash } from 'node:crypto'
import { alwaysProvider, getDestination, getDestinationFromDestinationService, isHttpDestination, type HttpDestination } from '@sap-cloud-sdk/connectivity'
import { muteLoggers } from '@sap-cloud-sdk/util'
import { isAllowedUrl } from './urls.js'

// SDK debug output can include destination credentials. Report only sanitized application errors.
muteLoggers()

export class CpiError extends Error {
  constructor(message: string, public status?: number) {
    super(message)
    this.name = 'CpiError'
  }
}

export interface ClientCredentials {
  tokenUrl: string
  clientId: string
  clientSecret: string
}

const TOKEN_TIMEOUT_MS = 30_000
const tokenCache = new Map<string, { token: string; expiresAt: number }>()

/** OAuth2 client-credentials token, cached in memory until shortly before it expires. */
export async function clientCredentialsToken(creds: ClientCredentials): Promise<string> {
  // Rotating a secret must invalidate the old token without retaining the secret as a cache key.
  const cacheKey = createHash('sha256').update(JSON.stringify([creds.tokenUrl, creds.clientId, creds.clientSecret])).digest('hex')
  const cached = tokenCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token

  const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64')
  let res: Response
  try {
    res = await fetch(creds.tokenUrl, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      },
      body: 'grant_type=client_credentials',
      redirect: 'error',
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS)
    })
  } catch {
    throw new CpiError('token request failed (connection error or timeout)')
  }
  if (!res.ok) throw new CpiError(`Token request failed: HTTP ${res.status}`, res.status)
  let body: { access_token: string; expires_in?: number }
  try {
    body = await res.json() as typeof body
    if (typeof body?.access_token !== 'string' || !body.access_token) throw new Error()
  } catch {
    throw new CpiError('Token request returned an invalid response')
  }
  tokenCache.set(cacheKey, {
    token: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 300) * 1000
  })
  return body.access_token
}

/**
 * Resolves an HTTP/Internet OAuth2ClientCredentials destination with a valid HTTPS URL.
 * `label` names the configuration in error messages (never the destination's credentials).
 */
export async function lookupDestination(destinationName: string, label: string): Promise<HttpDestination> {
  let destination
  try {
    const lookup = process.env.NODE_ENV === 'production' ? getDestinationFromDestinationService : getDestination
    destination = await lookup({ destinationName, selectionStrategy: alwaysProvider, useCache: true })
  } catch {
    // SDK errors may contain credentials or upstream response bodies.
    throw new CpiError(`Destination lookup failed for ${label}; check the destination and service binding`)
  }
  if (!destination) throw new CpiError(`Destination not found for ${label}; check the configured destination name`)
  if (!isHttpDestination(destination) || !isAllowedUrl(destination.url) || destination.authentication !== 'OAuth2ClientCredentials' || destination.proxyType !== 'Internet') {
    throw new CpiError('Destination must use a valid HTTPS URL, OAuth2ClientCredentials authentication and Internet proxy type')
  }
  return destination
}
