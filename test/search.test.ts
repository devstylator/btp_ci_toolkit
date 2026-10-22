import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer, type Server } from 'node:http'
import cds from '@sap/cds'
import { encrypt } from '../srv/lib/crypto.js'
import { zip } from './zip.js'
import { scanGroovy } from '../srv/features/search/groovy.js'
import { compilePattern, matcher } from '../srv/features/search/pattern.js'

const { UPDATE } = cds.ql
let app: Server
let upstream: Server
let base: string

const SCRIPT = `import com.sap.gateway.ip.core.customdev.util.Message
// def commented = message.getProperty("Commented")
/* message.setHeader("Hidden", 1) */
def Message processData(Message message) {
    String targetUrl = "https://orders.example.com/api" // trailing comment
    def orderId = message.getProperty('OrderId')
    def ct = message.getHeaders().get("Content-Type")
    def legacy = message.getHeaders().getHeader("hdr_name")
    message.setProperty("TargetUrl", targetUrl + "/" +
        orderId)
    message.setHeader("SAP_ApplicationID", orderId)
    message.getProperties().put("Copy", [a: 1, b: "x,y"])
    message.headers["Indexed"] = 'v'
    def text = "message.getProperty(\\"InString\\")"
    System.getProperty("java.version")
    return message
}`

test('wildcard patterns: contains match, * any text, + one character, case sensitivity', () => {
  assert.ok(compilePattern('url', false).test('Receiver_URL_Prod'))
  assert.ok(!compilePattern('url', true).test('Receiver_URL_Prod'))
  assert.ok(compilePattern('Receiver*Prod', true).test('Receiver_URL_Prod'))
  assert.ok(compilePattern('URL+Prod', true).test('Receiver_URL_Prod'))
  assert.ok(!compilePattern('URL+Prod', true).test('Receiver_URLProd'))
  assert.ok(compilePattern('a.b(c)', true).test('xa.b(c)'))
  assert.ok(!compilePattern('a.b', true).test('axb'))
  const both = matcher({ name: 'url', value: 'example' })
  assert.ok(both({ name: 'TargetUrl', value: 'https://example.com' }))
  assert.ok(!both({ name: 'TargetUrl', value: 'https://sap.com' }))
})

test('Groovy scan: variables, property/header reads and writes; comments, strings and System ignored', () => {
  const found = scanGroovy(SCRIPT).map(f => [f.kind, f.name, f.value, f.line])
  assert.deepEqual(found, [
    ['VARIABLE', 'targetUrl', '"https://orders.example.com/api"', 5],
    ['VARIABLE', 'orderId', "message.getProperty('OrderId')", 6],
    ['PROPERTY_READ', 'OrderId', '', 6],
    ['VARIABLE', 'ct', 'message.getHeaders().get("Content-Type")', 7],
    ['HEADER_READ', 'Content-Type', '', 7],
    ['VARIABLE', 'legacy', 'message.getHeaders().getHeader("hdr_name")', 8],
    ['HEADER_READ', 'hdr_name', '', 8],
    ['PROPERTY_WRITE', 'TargetUrl', 'targetUrl + "/" + orderId', 9],
    ['HEADER_WRITE', 'SAP_ApplicationID', 'orderId', 11],
    ['PROPERTY_WRITE', 'Copy', '[a: 1, b: "x,y"]', 12],
    ['HEADER_WRITE', 'Indexed', "'v'", 13],
    ['VARIABLE', 'text', '"message.getProperty(\\"InString\\")"', 14]
  ])
})

before(async () => {
  const iflow = zip([
    { path: 'META-INF/MANIFEST.MF', content: 'Manifest-Version: 1.0' },
    { path: 'src/main/resources/script/Orders.groovy', content: SCRIPT },
    { path: 'src/main/resources/mapping/x.mmap', content: 'message.getProperty("NotAScript")' }
  ])
  const collection = zip([{ path: 'src/main/resources/script/Util.groovy', content: 'def receiverUrl = "https://util.example.com"\n' }])
  upstream = createServer((request, response) => {
    if (request.url === '/token') {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ access_token: 'test-token', expires_in: 300 }))
      return
    }
    const url = decodeURIComponent(request.url ?? '')
    const ok = (d: unknown) => response.setHeader('Content-Type', 'application/json').end(JSON.stringify({ d }))
    if (url.startsWith("/api/v1/IntegrationPackages('Orders')/IntegrationDesigntimeArtifacts")) {
      ok({ results: [{ Id: 'OrdersFlow', Name: 'Orders Flow', Version: '1.0.3' }, { Id: 'Broken', Name: 'Broken Flow', Version: '1.0.0' }] })
    } else if (url.startsWith("/api/v1/IntegrationPackages('Orders')/ScriptCollectionDesigntimeArtifacts")) {
      ok({ results: [{ Id: 'Utils', Name: 'Utils', Version: '2.0.0' }] })
    } else if (url.startsWith("/api/v1/IntegrationPackages('Other')/")) {
      ok({ results: [] })
    } else if (url.startsWith("/api/v1/IntegrationPackages('Orders')")) {
      ok({ Id: 'Orders', Name: 'Orders Package' })
    } else if (url.startsWith('/api/v1/IntegrationPackages?')) {
      ok({ results: [{ Id: 'Other', Name: 'Other' }, { Id: 'Orders', Name: 'Orders Package' }] })
    } else if (url.startsWith("/api/v1/IntegrationDesigntimeArtifacts(Id='OrdersFlow',Version='active')/Configurations")) {
      ok({ results: [
        { ParameterKey: 'Receiver_URL', ParameterValue: 'https://orders.example.com', DataType: 'xsd:string' },
        { ParameterKey: 'Timeout', ParameterValue: '60000', DataType: 'xsd:integer' }
      ] })
    } else if (url.startsWith("/api/v1/IntegrationDesigntimeArtifacts(Id='OrdersFlow',Version='active')/$value")) {
      response.setHeader('Content-Type', 'application/zip').end(iflow)
    } else if (url.startsWith("/api/v1/ScriptCollectionDesigntimeArtifacts(Id='Utils',Version='active')/$value")) {
      response.setHeader('Content-Type', 'application/zip').end(collection)
    } else if (url.startsWith("/api/v1/IntegrationDesigntimeArtifacts(Id='Broken',")) {
      response.writeHead(500).end()
    } else response.writeHead(404).end()
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const tenant = `http://localhost:${(upstream.address() as { port: number }).port}`
  await (cds as any).deploy('*').to('sqlite::memory:')
  app = await cds.server({ port: 0 })
  base = `http://localhost:${(app.address() as { port: number }).port}`
  await UPDATE.entity('btp.toolkit.Connections').set({
    tenantUrl: tenant, tokenUrl: `${tenant}/token`, clientId: 'id', clientSecretEnc: encrypt('secret'), enabled: true
  }).where({ code: 'DEV' })
})

after(async () => {
  if (app) await new Promise<void>(resolve => app.close(() => resolve()))
  if (upstream) await new Promise<void>(resolve => upstream.close(() => resolve()))
  await (cds.db as any)?.disconnect()
})

const lit = (s: string) => `'${encodeURIComponent(s.replace(/'/g, "''"))}'`
async function search(params: Record<string, string | boolean>, user = 'bob:bob') {
  const args = Object.entries(params).map(([k, v]) => `${k}=${typeof v === 'string' ? lit(v) : v}`).join(',')
  const res = await fetch(`${base}/odata/v4/search/search(${args})`, {
    headers: { Authorization: `Basic ${Buffer.from(user).toString('base64')}` }
  })
  return { status: res.status, body: await res.json().catch(() => undefined) as any }
}

test('Search service', async t => {
  await t.test('finds iFlow parameters and script findings by name across all packages', async () => {
    const { status, body } = await search({ tenant: 'DEV', name: 'url' })
    assert.equal(status, 200)
    assert.equal(body.success, true)
    assert.deepEqual(body.findings.map((f: any) => [f.objectType, f.kind, f.artifactId, f.name]), [
      ['IFLOW', 'PARAMETER', 'OrdersFlow', 'Receiver_URL'],
      ['SCRIPT', 'VARIABLE', 'OrdersFlow', 'targetUrl'],
      ['SCRIPT', 'PROPERTY_WRITE', 'OrdersFlow', 'TargetUrl'],
      ['SCRIPT', 'VARIABLE', 'Utils', 'receiverUrl']
    ])
    const param = body.findings[0]
    assert.equal(param.value, 'https://orders.example.com')
    assert.equal(param.dataType, 'xsd:string')
    assert.equal(param.packageName, 'Orders Package')
    const write = body.findings[2]
    assert.equal(write.scriptPath, 'src/main/resources/script/Orders.groovy')
    assert.equal(write.line, 9)
    assert.deepEqual([body.summary.packages, body.summary.artifacts, body.summary.scripts, body.summary.failures], [2, 3, 2, 2])
    assert.ok(body.log.some((e: any) => e.level === 'WARN' && e.message.includes('Broken Flow')))
  })

  await t.test('value pattern with wildcards, case sensitivity and object type filter', async () => {
    const iflowsOnly = await search({ tenant: 'DEV', value: 'https://*.example.+om', iflows: true, scripts: false })
    assert.deepEqual(iflowsOnly.body.findings.map((f: any) => f.name), ['Receiver_URL'])
    const scriptsOnly = await search({ tenant: 'DEV', packageId: 'Orders', name: 'targeturl', caseSensitive: true, iflows: false, scripts: true })
    assert.deepEqual(scriptsOnly.body.findings, [])
    const insensitive = await search({ tenant: 'DEV', packageId: 'Orders', name: 'targeturl', iflows: false, scripts: true })
    assert.deepEqual(insensitive.body.findings.map((f: any) => f.name), ['targetUrl', 'TargetUrl'])
  })

  await t.test('name AND value must match', async () => {
    const { body } = await search({ tenant: 'DEV', name: 'Receiver', value: 'util' })
    assert.deepEqual(body.findings.map((f: any) => [f.artifactId, f.name]), [['Utils', 'receiverUrl']])
  })

  await t.test('unknown package -> success=false with ERROR log', async () => {
    const { status, body } = await search({ tenant: 'DEV', packageId: 'Nope', name: 'x' })
    assert.equal(status, 200)
    assert.equal(body.success, false)
    assert.ok(body.log.some((e: any) => e.level === 'ERROR' && e.message.includes("'Nope'")))
  })

  await t.test('validation: pattern and type required, tenant checked; unconfigured tenant -> 412', async () => {
    assert.equal((await search({ tenant: 'DEV' })).status, 400)
    assert.equal((await search({ tenant: 'DEV', name: 'x', iflows: false, scripts: false })).status, 400)
    assert.equal((await search({ tenant: 'QA', name: 'x' })).status, 400)
    assert.equal((await search({ tenant: 'PROD', name: 'x' })).status, 412)
  })

  await t.test('package value help', async () => {
    const res = await fetch(`${base}/odata/v4/search/listPackages(tenant='DEV')`, {
      headers: { Authorization: `Basic ${Buffer.from('bob:bob').toString('base64')}` }
    })
    assert.deepEqual((await res.json() as any).value.map((p: any) => p.id), ['Orders', 'Other'])
  })
})
