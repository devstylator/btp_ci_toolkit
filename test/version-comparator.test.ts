import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer, type Server } from 'node:http'
import cds from '@sap/cds'
import { encrypt } from '../srv/lib/crypto.js'

const { UPDATE } = cds.ql
let app: Server
let upstream: Server
let base: string

/** Fake tenants: DEV under /dev, PROD under /prod. */
const TENANTS: Record<string, Record<string, unknown[]>> = {
  dev: {
    IntegrationPackages: [
      { Id: 'Sales', Name: 'Sales Integration', ShortText: 'Orders and invoices', Version: '1.0.0' },
      { Id: 'Finance', Name: 'Finance', ShortText: '', Description: 'Long finance text', Version: '2.0.0' }
    ],
    "IntegrationPackages('Sales')": [{ Id: 'Sales', Name: 'Sales Integration', ShortText: 'Orders and invoices', Version: '1.0.0' }],
    "IntegrationPackages('Sales')/IntegrationDesigntimeArtifacts": [
      { Id: 'Orders', Name: 'Orders API', Version: '1.0.4' },
      { Id: 'Invoices', Name: 'Invoices', Version: '1.1.0' },
      { Id: 'NewFlow', Name: 'New flow', Version: '1.0.0' }
    ],
    "IntegrationPackages('Sales')/ValueMappingDesigntimeArtifacts": [],
    "IntegrationPackages('Sales')/MessageMappingDesigntimeArtifacts": [],
    "IntegrationPackages('Sales')/ScriptCollectionDesigntimeArtifacts": [{ Id: 'Scripts', Name: 'Scripts', Version: '1.0.0' }]
  },
  prod: {
    // same package version, different artifact versions
    "IntegrationPackages('Sales')": [{ Id: 'Sales', Name: 'Sales Integration', Version: '1.0.0' }],
    "IntegrationPackages('Sales')/IntegrationDesigntimeArtifacts": [
      { Id: 'Orders', Name: 'Orders API', Version: '1.0.4' },
      { Id: 'Invoices', Name: 'Invoices', Version: '1.0.9' },
      { Id: 'OldFlow', Name: 'Old flow', Version: '0.9.0' }
    ],
    "IntegrationPackages('Sales')/ValueMappingDesigntimeArtifacts": [],
    "IntegrationPackages('Sales')/MessageMappingDesigntimeArtifacts": [],
    "IntegrationPackages('Sales')/ScriptCollectionDesigntimeArtifacts": [{ Id: 'Scripts', Name: 'Scripts', Version: '1.0.0' }]
  }
}

before(async () => {
  upstream = createServer((request, response) => {
    if (request.url === '/token') {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ access_token: 'test-token', expires_in: 300 }))
      return
    }
    if (request.headers.authorization !== 'Bearer test-token') {
      response.writeHead(401).end()
      return
    }
    const match = /^\/(dev|prod)\/api\/v1\/([^?]*)/.exec(decodeURIComponent(request.url ?? ''))
    const results = match && TENANTS[match[1]][match[2]]
    if (!results) {
      response.writeHead(404).end()
      return
    }
    response.setHeader('Content-Type', 'application/json').end(JSON.stringify({ d: { results } }))
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const tenant = `http://localhost:${(upstream.address() as { port: number }).port}`
  await (cds as any).deploy('*').to('sqlite::memory:')
  app = await cds.server({ port: 0 })
  base = `http://localhost:${(app.address() as { port: number }).port}`
  for (const code of ['DEV', 'PROD']) {
    await UPDATE.entity('btp.toolkit.Connections').set({
      tenantUrl: `${tenant}/${code.toLowerCase()}`, tokenUrl: `${tenant}/token`, clientId: 'id', clientSecretEnc: encrypt('secret'), enabled: true
    }).where({ code })
  }
})

after(async () => {
  if (app) await new Promise<void>(resolve => app.close(() => resolve()))
  if (upstream) await new Promise<void>(resolve => upstream.close(() => resolve()))
  await (cds.db as any)?.disconnect()
})

async function call(path: string, body?: unknown) {
  const res = await fetch(`${base}/odata/v4/version-comparator/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Basic ${Buffer.from('bob:bob').toString('base64')}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  })
  return { status: res.status, body: await res.json().catch(() => undefined) as any }
}

test('Version Comparator service', async t => {
  await t.test('lists DEV packages with description, sorted by name, without versions', async () => {
    const { status, body } = await call('listPackages()')
    assert.equal(status, 200)
    assert.deepEqual(body.value, [
      { id: 'Finance', name: 'Finance', description: 'Long finance text' },
      { id: 'Sales', name: 'Sales Integration', description: 'Orders and invoices' }
    ])
  })

  await t.test('compares all artifacts of a package; no package row', async () => {
    const { status, body } = await call('compare', { packageId: 'Sales' })
    assert.equal(status, 200)
    assert.equal(body.success, true)
    assert.deepEqual(body.package, { id: 'Sales', name: 'Sales Integration', description: 'Orders and invoices', inDev: true, inProd: true })
    assert.deepEqual(body.rows.map((r: any) => [r.artifactType, r.artifactId, r.devVersion, r.prodVersion, r.status]), [
      ['IntegrationFlow', 'Invoices', '1.1.0', '1.0.9', 'MISMATCH'],
      ['IntegrationFlow', 'NewFlow', '1.0.0', null, 'MISSING_IN_PROD'],
      ['IntegrationFlow', 'OldFlow', null, '0.9.0', 'MISSING_IN_DEV'],
      ['IntegrationFlow', 'Orders', '1.0.4', '1.0.4', 'MATCH'],
      ['ScriptCollection', 'Scripts', '1.0.0', '1.0.0', 'MATCH']
    ])
    assert.deepEqual(body.summary, { total: 5, matching: 2, mismatching: 1, missingInDev: 1, missingInProd: 1 })
  })

  await t.test('package missing in PROD -> all artifacts missing in PROD', async () => {
    TENANTS.dev["IntegrationPackages('Finance')"] = [{ Id: 'Finance', Name: 'Finance', Description: 'Long finance text' }]
    TENANTS.dev["IntegrationPackages('Finance')/IntegrationDesigntimeArtifacts"] = [{ Id: 'Ledger', Name: 'Ledger', Version: '1.0.0' }]
    const { body } = await call('compare', { packageId: 'Finance' })
    assert.equal(body.success, true)
    assert.equal(body.package.inProd, false)
    assert.deepEqual(body.rows.map((r: any) => r.status), ['MISSING_IN_PROD'])
    assert.ok(body.log.some((l: any) => l.level === 'WARN' && l.message.includes("PROD: package 'Finance' not found")))
  })

  await t.test('unknown package -> success=false; missing packageId -> 400', async () => {
    const { body } = await call('compare', { packageId: 'Nope' })
    assert.equal(body.success, false)
    assert.equal(body.log.at(-1).level, 'ERROR')
    assert.equal((await call('compare', { packageId: ' ' })).status, 400)
  })
})
