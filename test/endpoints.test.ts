import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer, type Server } from 'node:http'
import { crc32, deflateRawSync } from 'node:zlib'
import cds from '@sap/cds'
import { encrypt } from '../srv/lib/crypto.js'
import { adapterFromUrl, addressMatches, artifactIdFromEndpointId, parseSenderChannels, toSenderChannels } from '../srv/features/endpoints/iflow.js'

const { UPDATE } = cds.ql
let app: Server
let upstream: Server
let base: string
let tenant: string

/** Minimal ZIP writer (deflated entries), like a CPI artifact export. */
function zip(files: { path: string; content: string | Buffer }[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const f of files) {
    const raw = Buffer.from(f.content)
    const data = deflateRawSync(raw)
    const name = Buffer.from(f.path)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc32(raw), 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10)
    central.writeUInt32LE(crc32(raw), 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42)
    locals.push(local, name, data)
    centrals.push(central, name)
    offset += 30 + name.length + data.length
  }
  const dir = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, dir, end])
}

const prop = (key: string, value: string) => `<ifl:property><key>${key}</key><value>${value}</value></ifl:property>`
const IFLW = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn2:definitions xmlns:bpmn2="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:ifl="http:///com.sap.ifl.model/Ifl.xsd">
  <bpmn2:collaboration id="Collaboration_1" name="Default Collaboration">
    <bpmn2:participant id="Participant_1" ifl:type="EndpointSender" name="Sender"/>
    <bpmn2:participant id="Participant_2" ifl:type="EndpointRecevier" name="Receiver"/>
    <bpmn2:participant id="Participant_Process_1" ifl:type="IntegrationProcess" name="Process"/>
    <bpmn2:messageFlow id="MessageFlow_1" name="HTTPS" sourceRef="Participant_1" targetRef="StartEvent_1">
      <bpmn2:extensionElements>
        ${prop('ComponentType', 'HTTPS')}${prop('address', '/orders/v1')}${prop('senderAuthType', 'RoleBased')}
        ${prop('userRole', '{{Sender Role}}')}${prop('xsrfProtection', '0')}
      </bpmn2:extensionElements>
    </bpmn2:messageFlow>
    <bpmn2:messageFlow id="MessageFlow_2" name="SOAP" sourceRef="Participant_1" targetRef="StartEvent_1">
      <bpmn2:extensionElements>
        ${prop('ComponentType', 'SOAP')}${prop('address', '/orders/soap')}${prop('senderAuthType', 'ClientCertificate')}
        ${prop('clientCertificates', 'CN=client&amp;co')}
      </bpmn2:extensionElements>
    </bpmn2:messageFlow>
    <bpmn2:messageFlow id="MessageFlow_3" name="HTTP" sourceRef="EndEvent_1" targetRef="Participant_2">
      <bpmn2:extensionElements>${prop('ComponentType', 'HTTP')}${prop('httpAddressWithoutQuery', 'https://x')}${prop('direction', 'Receiver')}${prop('password', 'nope')}</bpmn2:extensionElements>
    </bpmn2:messageFlow>
  </bpmn2:collaboration>
</bpmn2:definitions>`

test('adapter is derived from the runtime URL path and the API protocol', () => {
  assert.equal(adapterFromUrl('https://t.example/http/orders', 'REST'), 'HTTPS')
  assert.equal(adapterFromUrl('https://t.example/cxf/orders', 'SOAP'), 'SOAP')
  assert.equal(adapterFromUrl('https://t.example/cxf/idoc', 'IDOC'), 'IDoc')
  assert.equal(adapterFromUrl('https://t.example/gw/odata/SAP/X', 'ODATA'), 'OData')
  assert.equal(adapterFromUrl('https://t.example/cxf/x', ''), 'SOAP')
})

test('sender channels are parsed, parameters resolved, receivers and credentials ignored', () => {
  const channels = toSenderChannels(parseSenderChannels(IFLW), new Map([['Sender Role', 'Orders.Send']]))
  assert.equal(channels.length, 2)
  assert.deepEqual(channels.map(c => [c.adapter, c.address, c.authentication, c.userRole]), [
    ['HTTPS', '/orders/v1', 'RoleBased', 'Orders.Send'],
    ['SOAP', '/orders/soap', 'ClientCertificate', '']
  ])
  assert.equal(channels[1].certificates, 'CN=client&co')
  assert.ok(!JSON.stringify(channels).includes('nope'))
})

test('artifact ID is taken from the ServiceEndpoints ID', () => {
  assert.equal(artifactIdFromEndpointId('Orders$endpointAddress=http/orders/v1'), 'Orders')
  assert.equal(artifactIdFromEndpointId('Orders'), 'Orders')
})

test('channel address matches the endpoint URL', () => {
  assert.ok(addressMatches('https://t.example/http/orders/v1', '/orders/v1'))
  assert.ok(addressMatches('https://t.example/http/orders/v1/', 'orders/v1'))
  assert.ok(addressMatches('https://t.example/http/orders/v1/items', '/orders/*'))
  assert.ok(!addressMatches('https://t.example/http/orders/v2', '/orders/v1'))
  assert.ok(!addressMatches('https://t.example/http/orders/v1', ''))
})

before(async () => {
  const designtime = zip([
    { path: 'META-INF/MANIFEST.MF', content: 'Manifest-Version: 1.0' },
    { path: 'src/main/resources/scenarioflows/integrationflow/Orders.iflw', content: IFLW }
  ])
  // runtime bundle with the design-time archive nested inside
  const runtime = zip([{ path: 'META-INF/MANIFEST.MF', content: 'x' }, { path: 'content/Orders.zip', content: designtime }])
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
    const url = decodeURIComponent(request.url ?? '')
    const ok = (d: unknown) => response.setHeader('Content-Type', 'application/json').end(JSON.stringify({ d }))
    const bin = (b: Buffer) => response.setHeader('Content-Type', 'application/zip').end(b)
    if (url.startsWith('/api/v1/ServiceEndpoints')) {
      ok({ results: [
        { Id: 'Orders$endpointAddress=http/orders/v1', Name: 'Orders', Title: 'Orders API', Version: '1.0.4', Protocol: 'REST',
          EntryPoints: { results: [{ Name: 'Orders', Url: `${tenant}/http/orders/v1`, Type: 'PROD' }] } },
        { Id: 'Legacy$endpointAddress=cxf/legacy', Name: 'Legacy', Title: 'Legacy SOAP', Version: '2.0.0', Protocol: 'SOAP',
          EntryPoints: { results: [{ Name: 'Legacy', Url: `${tenant}/cxf/legacy`, Type: 'PROD' }] } }
      ] })
    } else if (url.startsWith('/api/v1/IntegrationRuntimeArtifacts?')) {
      ok({ results: [
        { Id: 'Orders', Name: 'Orders API', Version: '1.0.4', Status: 'STARTED' },
        { Id: 'Legacy', Name: 'Legacy SOAP', Version: '2.0.0', Status: 'STARTED', DeployedBy: 'joe', DeployedOn: '/Date(1760000000000)/' }
      ] })
    } else if (url.startsWith("/api/v1/IntegrationRuntimeArtifacts('Orders')/$value")) bin(runtime)
    else if (url.startsWith("/api/v1/IntegrationRuntimeArtifacts('Orders')")) {
      ok({ Id: 'Orders', Version: '1.0.4', Status: 'STARTED', DeployedBy: 'jane@example.com', DeployedOn: '/Date(1760000000000)/' })
    } else if (url.startsWith("/api/v1/IntegrationDesigntimeArtifacts(Id='Orders',Version='active')/Configurations")) {
      ok({ results: [{ ParameterKey: 'Sender Role', ParameterValue: 'Orders.Send', DataType: 'xsd:string' }] })
    } else if (url.startsWith("/api/v1/IntegrationRuntimeArtifacts('Legacy')/$value")) response.writeHead(500).end()
    else if (url.startsWith("/api/v1/IntegrationRuntimeArtifacts('Legacy')")) response.writeHead(500).end()
    else if (url.startsWith("/api/v1/IntegrationDesigntimeArtifacts(Id='Legacy',Version='active')/$value")) bin(designtime)
    else response.writeHead(404).end()
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  tenant = `http://localhost:${(upstream.address() as { port: number }).port}`
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

const lit = (s: string) => `'${encodeURIComponent(s)}'`
async function call(path: string, user = 'bob:bob') {
  const res = await fetch(`${base}/odata/v4/endpoints/${path}`, {
    headers: { Authorization: `Basic ${Buffer.from(user).toString('base64')}` }
  })
  return { status: res.status, body: await res.json().catch(() => undefined) as any }
}

test('Endpoints service', async t => {
  await t.test('lists DEV endpoints and skips the unconfigured PROD tenant with a warning', async () => {
    const { status, body } = await call('listEndpoints()')
    assert.equal(status, 200)
    assert.deepEqual(body.endpoints.map((e: any) => [e.tenant, e.iflowId, e.iflowName, e.adapter]), [
      ['DEV', 'Legacy', 'Legacy SOAP', 'SOAP'], ['DEV', 'Orders', 'Orders API', 'HTTPS']
    ])
    assert.deepEqual(body.messages.map((m: any) => [m.tenant, m.level]), [['PROD', 'WARN']])
  })

  await t.test('details: deployment, matched sender channel with resolved role from the runtime artifact', async () => {
    const { status, body } = await call(`endpointDetails(tenant='DEV',iflowId='Orders',url=${lit(`${tenant}/http/orders/v1`)})`)
    assert.equal(status, 200)
    assert.deepEqual(body.deployment, { version: '1.0.4', status: 'STARTED', deployedBy: 'jane@example.com', deployedOn: '2025-10-09T08:53:20.000Z' })
    assert.equal(body.contentSource, 'RUNTIME')
    assert.equal(body.matched, true)
    assert.deepEqual(body.channels.map((c: any) => [c.adapter, c.userRole]), [['HTTPS', 'Orders.Send']])
  })

  await t.test('details: falls back to the design-time content and shows all channels when nothing matches', async () => {
    const { body } = await call(`endpointDetails(tenant='DEV',iflowId='Legacy',url=${lit(`${tenant}/cxf/legacy`)})`)
    assert.equal(body.contentSource, 'DESIGNTIME')
    assert.equal(body.deployment.deployedBy, 'joe') // single GET failed (HTTP 500) -> taken from the artifact list
    assert.equal(body.matched, false)
    assert.equal(body.channels.length, 2)
  })

  await t.test('details: an endpoint ID (<iflow>$endpointAddress=...) is reduced to the iFlow ID', async () => {
    const { status, body } = await call(`endpointDetails(tenant='DEV',iflowId=${lit('Orders$endpointAddress=http/orders/v1')},url=${lit(`${tenant}/http/orders/v1`)})`)
    assert.equal(status, 200)
    assert.equal(body.deployment.version, '1.0.4')
  })

  await t.test('details: unconfigured tenant -> 412, bad tenant -> 400', async () => {
    assert.equal((await call(`endpointDetails(tenant='PROD',iflowId='Orders',url='x')`)).status, 412)
    assert.equal((await call(`endpointDetails(tenant='QA',iflowId='Orders',url='x')`)).status, 400)
  })
})
