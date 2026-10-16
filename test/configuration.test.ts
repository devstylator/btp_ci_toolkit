import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer, type Server } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { upgradeLocal } from '../scripts/upgrade-local.mjs'
import cds from '@sap/cds'
import { CpiClient } from '../srv/lib/cpi-client.js'
import { loadConnection } from '../srv/lib/connections.js'
import { encrypt } from '../srv/lib/crypto.js'
import { isAllowedUrl } from '../srv/lib/urls.js'

const { SELECT, UPDATE } = cds.ql
const table = 'btp.toolkit.Connections'
let app: Server
let upstream: Server
let base: string
let tenant: string
let writes = 0
let tokens = 0
let requests = 0
const req = { reject(status: number, message: string): never { throw Object.assign(new Error(message), { statusCode: status }) } }

before(async () => {
  upstream = createServer((request, response) => {
    requests++
    if (request.url === '/token') {
      tokens++
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ access_token: 'test-token', expires_in: 300 }))
      return
    }
    if (request.headers.authorization !== 'Bearer test-token') {
      response.writeHead(401).end()
      return
    }
    if (request.method === 'HEAD') {
      response.setHeader('x-csrf-token', 'test-csrf')
      response.setHeader('set-cookie', 'session=test; Path=/')
      response.end()
      return
    }
    response.setHeader('Content-Type', 'application/json')
    if (request.method !== 'GET') {
      if (request.headers['x-csrf-token'] !== 'test-csrf' || !request.headers.cookie?.includes('session=test')) {
        response.writeHead(403).end()
        return
      }
      writes++
      response.end(JSON.stringify({ ok: true }))
    } else if (request.url?.includes('Missing')) response.writeHead(404).end()
    else if (request.url?.includes('Unsafe')) response.end(JSON.stringify({ d: { results: [], __next: 'https://example.invalid/api/v1/stolen' } }))
    else if (request.url?.includes('page=2')) response.end(JSON.stringify({ d: { results: [{ Id: 'second', Name: 'Second', Version: '1' }] } }))
    else response.end(JSON.stringify({ d: { results: [{ Id: 'first', Name: 'First', Version: '1' }], __next: `${tenant}/api/v1/IntegrationPackages?page=2` } }))
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  tenant = `http://localhost:${(upstream.address() as { port: number }).port}`
  process.env.destinations = JSON.stringify([{
    name: 'TEST_CPI', url: tenant, authentication: 'OAuth2ClientCredentials', proxyType: 'Internet',
    authTokens: [{ type: 'Bearer', value: 'test-token', expiresIn: '300', http_header: { key: 'Authorization', value: 'Bearer test-token' }, error: null }]
  }, { name: 'INVALID_CPI', url: tenant, authentication: 'NoAuthentication', proxyType: 'Internet' }])
  await (cds as any).deploy('*').to('sqlite::memory:')
  app = await cds.server({ port: 0 })
  base = `http://localhost:${(app.address() as { port: number }).port}`
})

after(async () => {
  delete process.env.destinations
  if (app) await new Promise<void>(resolve => app.close(() => resolve()))
  if (upstream) await new Promise<void>(resolve => upstream.close(() => resolve()))
  await (cds.db as any)?.disconnect()
})

async function api(path: string, method = 'GET', data?: unknown, user = 'alice') {
  return fetch(`${base}/odata/v4/config/${path}`, {
    method,
    headers: { Authorization: `Basic ${Buffer.from(`${user}:${user}`).toString('base64')}`, 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data)
  })
}

async function draft(code = 'DEV') {
  const response = await api(`Connections(code='${code}',IsActiveEntity=true)/ConfigService.draftEdit`, 'POST', { PreserveChanges: false })
  assert.equal(response.status, 201, await response.clone().text())
  return `Connections(code='${code}',IsActiveEntity=false)`
}

test('configuration, CPI transport and modification policy', async t => {
  await t.test('local upgrade preserves active/draft credentials and can be rerun', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'btp-upgrade-'))
    const filename = join(directory, 'legacy.sqlite')
    try {
      const legacy = new DatabaseSync(filename)
      for (const table of ['btp_toolkit_Connections', 'ConfigService_Connections_drafts']) {
        legacy.exec(`CREATE TABLE "${table}" (code TEXT PRIMARY KEY, tenantUrl TEXT, clientSecretEnc TEXT,
          createdAt TEXT, createdBy TEXT, modifiedAt TEXT, modifiedBy TEXT, name TEXT, tokenUrl TEXT,
          clientId TEXT, enabled BOOLEAN, lastTestAt TEXT, lastTestOk BOOLEAN, lastTestMessage TEXT)`)
        legacy.prepare(`INSERT INTO "${table}" (code, tenantUrl, clientSecretEnc) VALUES (?, ?, ?)`).run('DEV', 'https://preserved.invalid', 'encrypted-secret')
      }
      legacy.exec('CREATE VIEW ConfigService_Connections AS SELECT code, tenantUrl FROM btp_toolkit_Connections')
      legacy.close()
      await upgradeLocal(filename)
      await upgradeLocal(filename)
      const upgraded = new DatabaseSync(filename)
      try {
        for (const table of ['btp_toolkit_Connections', 'ConfigService_Connections_drafts']) {
          const row = upgraded.prepare(`SELECT * FROM "${table}"`).get()!
          assert.equal(row.tenantUrl, 'https://preserved.invalid')
          assert.equal(row.clientSecretEnc, 'encrypted-secret')
          assert.equal(row.connectionMode, 'DIRECT')
          assert.equal(row.allowModifications, 0)
        }
        const projected = upgraded.prepare('SELECT * FROM ConfigService_Connections').get()!
        assert.equal(projected.connectionMode, 'DIRECT')
        assert.equal(projected.allowModifications, 0)
        assert.ok(!('clientSecretEnc' in projected))
      } finally { upgraded.close() }
    } finally { await rm(directory, { recursive: true }) }
  })

  await t.test('defaults and Admin-only configuration; encrypted secrets excluded', async () => {
    const response = await api('Connections')
    assert.equal(response.status, 200)
    const rows = (await response.json()).value
    assert.equal(rows.length, 2)
    assert.ok(rows.every((row: any) => row.connectionMode === 'DIRECT' && row.allowModifications === false && !('clientSecretEnc' in row)))
    assert.equal((await api('Connections', 'GET', undefined, 'bob')).status, 403)
    assert.equal((await api('ConnectionModes', 'GET', undefined, 'bob')).status, 403)
    assert.equal((await api('ConnectionModes')).status, 200)
  })

  await t.test('existing direct credentials still read and page; token reused', async () => {
    for (const code of ['DEV', 'PROD']) await UPDATE.entity(table).set({ tenantUrl: tenant, tokenUrl: `${tenant}/token`, clientId: 'test', clientSecretEnc: encrypt('test-secret') }).where({ code })
    const client = new CpiClient(await loadConnection('DEV', req))
    assert.equal((await client.get('IntegrationPackages'))?.length, 2)
    assert.equal(await client.get('Missing'), undefined)
    assert.equal(tokens, 1)
    await assert.rejects(client.get('Unsafe'), /within the configured tenant API/)
  })

  await t.test('read-only CPI comparison POST remains usable', async () => {
    const response = await fetch(`${base}/odata/v4/version-comparator/compare`, {
      method: 'POST', headers: { Authorization: `Basic ${Buffer.from('bob:bob').toString('base64')}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ packageId: 'first' })
    })
    assert.equal(response.status, 200, await response.clone().text())
    assert.equal((await response.json()).success, true)
  })

  await t.test('draft validates destination name on save and supports independent DEV/PROD modes', async () => {
    const path = await draft()
    await api(path, 'PATCH', { connectionMode: 'UNKNOWN' })
    assert.equal((await api(`${path}/ConfigService.draftActivate`, 'POST', {})).status, 400)
    assert.equal((await api(path, 'PATCH', { connectionMode: 'DESTINATION' })).status, 200)
    assert.equal((await api(`${path}/ConfigService.draftActivate`, 'POST', {})).status, 400)
    assert.equal((await api(path, 'PATCH', { destinationName: 'TEST_CPI' })).status, 200)
    const saved = await api(`${path}/ConfigService.draftActivate`, 'POST', {})
    assert.equal(saved.status, 200, await saved.clone().text())
    assert.equal((await saved.json()).connectionMode, 'DESTINATION')
    const prod = await SELECT.one.from(table).where({ code: 'PROD' })
    assert.equal(prod.connectionMode, 'DIRECT')
    const conn = await loadConnection('DEV', req)
    assert.deepEqual(conn, { code: 'DEV', connectionMode: 'DESTINATION', destinationName: 'TEST_CPI' })
    assert.equal((await new CpiClient(conn).get('IntegrationPackages'))?.length, 2)
    assert.equal((await api("Connections(code='DEV',IsActiveEntity=true)/ConfigService.setSecret", 'POST', { secret: 'unused' })).status, 400)
  })

  await t.test('test action works for either mode and reports sanitized destination errors', async () => {
    for (const code of ['DEV', 'PROD']) {
      const response = await api(`Connections(code='${code}',IsActiveEntity=true)/ConfigService.test`, 'POST', {})
      assert.equal(response.status, 200)
      assert.equal((await response.json()).ok, true)
    }
    await UPDATE.entity(table).set({ destinationName: 'INVALID_CPI' }).where({ code: 'DEV' })
    const response = await api("Connections(code='DEV',IsActiveEntity=true)/ConfigService.test", 'POST', {})
    assert.equal((await response.json()).ok, false)
    const row = await SELECT.one.from(table).where({ code: 'DEV' })
    assert.equal(row.lastTestOk, false)
    assert.ok(!row.lastTestMessage.includes('test-token'))
    await UPDATE.entity(table).set({ destinationName: 'TEST_CPI' }).where({ code: 'DEV' })
  })

  await t.test('all writes blocked before upstream calls; saved policy overrides old clients', async () => {
    const client = new CpiClient(await loadConnection('DEV', req))
    const count = requests
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      await assert.rejects(client.write(method, 'IntegrationPackages'), { statusCode: 403 })
    }
    assert.equal(requests, count)
    const path = await draft()
    await api(path, 'PATCH', { allowModifications: true })
    await assert.rejects(client.write('POST', 'IntegrationPackages'), { statusCode: 403 })
    assert.equal((await api(`${path}/ConfigService.draftActivate`, 'POST', {})).status, 200)
    assert.deepEqual(await client.write('POST', 'IntegrationPackages', { name: 'test' }), { ok: true })
    assert.equal(writes, 1)
    const prod = new CpiClient(await loadConnection('PROD', req))
    await assert.rejects(prod.write('DELETE', 'IntegrationPackages'), { statusCode: 403 })
    await UPDATE.entity(table).set({ allowModifications: true }).where({ code: 'PROD' })
    assert.deepEqual(await prod.write('PATCH', 'IntegrationPackages', { name: 'test' }), { ok: true })
    assert.equal(writes, 2)
    await UPDATE.entity(table).set({ allowModifications: false }).where({ code: 'DEV' })
    await assert.rejects(client.write('DELETE', 'IntegrationPackages'), { statusCode: 403 })
    await UPDATE.entity(table).set({ allowModifications: true, enabled: false }).where({ code: 'DEV' })
    await assert.rejects(client.write('POST', 'IntegrationPackages'), { statusCode: 403 })
    await assert.rejects(loadConnection('DEV', req), { statusCode: 412 })
  })

  await t.test('production ignores local SDK destinations and rejects HTTP URLs', async () => {
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      assert.equal(isAllowedUrl(tenant), false)
      assert.equal(isAllowedUrl('https://tenant.example'), true)
      await assert.rejects(new CpiClient({ code: 'DEV', connectionMode: 'DESTINATION', destinationName: 'TEST_CPI' }).get('IntegrationPackages'), /Destination lookup failed/)
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = previous
    }
  })
})
