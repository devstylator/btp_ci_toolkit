import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer, type Server } from 'node:http'
import cds from '@sap/cds'
import { encrypt } from '../srv/lib/crypto.js'
import { zip } from './zip.js'
import { cockpitLink, looksLikePir } from '../srv/lib/service-manager.js'
import { adapterFromUrl, addressMatches, artifactIdFromEndpointId, servicePath, parseSenderChannels, toSenderChannels } from '../srv/features/endpoints/iflow.js'

const { INSERT, UPDATE } = cds.ql
let app: Server
let upstream: Server
let base: string
let tenant: string
let hanaParamsRead = 0

// fake SAP Service Manager: two pages of instances; plan of pir-orders is not visible (like plan subaccount-audit)
const ctx = { global_account_id: 'ga1', subaccount_id: 'sa1', space_name: 'dev', organization_name: 'org' }
const SM_PAGES: Record<string, unknown> = {
  first: { num_items: 4, token: 'page2', items: [
    { id: 'i-orders', name: 'pir-orders', service_plan_id: 'p-hidden', subaccount_id: 'sa1', created_at: '2026-01-01T00:00:00Z', context: ctx },
    { id: 'i-xsuaa', name: 'app-auth', service_plan_id: 'p-hidden-2', context: ctx }
  ] },
  page2: { num_items: 4, items: [
    { id: 'i-api', name: 'pir-api', service_plan_id: 'p-api', subaccount_id: 'sa1', context: ctx },
    { id: 'i-hana', name: 'db', service_plan_id: 'p-hana', context: ctx }
  ] }
}
const SM_PARAMS: Record<string, unknown> = {
  'i-orders': { roles: ['Orders.Send', 'ESBMessaging.send'], 'grant-types': ['client_credentials'], 'token-validity': 3600 },
  'i-xsuaa': { xsappname: 'app', 'grant-types': ['client_credentials'], roles: [] },
  'i-api': { roles: ['WorkspacePackagesRead'], 'grant-types': ['client_credentials'] }
}
function serviceManager(url: string): unknown {
  const u = new URL(url, 'http://x')
  if (u.pathname === '/sm/v1/service_instances') return SM_PAGES[u.searchParams.get('token') ?? 'first']
  if (u.pathname === '/sm/v1/service_plans') return { items: [
    { id: 'p-api', catalog_name: 'api', service_offering_id: 'o-it' },
    { id: 'p-hana', catalog_name: 'hdi-shared', service_offering_id: 'o-hana' }
  ] }
  if (u.pathname === '/sm/v1/service_offerings') return { items: [{ id: 'o-it', catalog_name: 'it-rt' }, { id: 'o-hana', catalog_name: 'hana' }] }
  const params = /^\/sm\/v1\/service_instances\/([^/]+)\/parameters$/.exec(u.pathname)
  if (params?.[1] === 'i-hana') hanaParamsRead++
  return params ? SM_PARAMS[params[1]] : undefined
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

test('service path is the URL without the tenant host', () => {
  assert.equal(servicePath('https://t.example.com/http/test/script'), '/http/test/script')
  assert.equal(servicePath('https://t.example.com/gw/odata/SAP/X;v=1?a=b'), '/gw/odata/SAP/X;v=1?a=b')
  assert.equal(servicePath('not a url'), 'not a url')
})

test('artifact ID is taken from the ServiceEndpoints ID', () => {
  assert.equal(artifactIdFromEndpointId('Orders$endpointAddress=http/orders/v1'), 'Orders')
  assert.equal(artifactIdFromEndpointId('Orders'), 'Orders')
})

test('cockpit link and PIR detection by parameters', () => {
  assert.equal(cockpitLink('https://account.hanatrial.ondemand.com/trial/', 'ga', 'sa', 'id'),
    'https://account.hanatrial.ondemand.com/trial/#/globalaccount/ga/subaccount/sa/service-instances&//detail/id/?layout=TwoColumnsMidExpanded')
  assert.equal(cockpitLink('', 'ga', 'sa', 'id'), '')
  assert.ok(looksLikePir({ roles: ['A'], 'grant-types': ['client_credentials'] }))
  assert.ok(!looksLikePir({ xsappname: 'x', roles: [], 'grant-types': [] }))
  assert.ok(!looksLikePir(undefined))
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
    if (request.url?.startsWith('/sm/')) {
      const data = serviceManager(request.url)
      if (data) response.setHeader('Content-Type', 'application/json').end(JSON.stringify(data))
      else response.writeHead(404).end()
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
    } else if (url.startsWith('/api/v1/IntegrationPackages?')) {
      ok({ results: [{ Id: 'Sales', Name: 'Sales Integration' }, { Id: 'Finance', Name: 'Finance' }] })
    } else if (url.startsWith("/api/v1/IntegrationPackages('Sales')/IntegrationDesigntimeArtifacts")) {
      ok({ results: [{ Id: 'Orders', Name: 'Orders API', Version: '1.0.4' }] })
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
  await INSERT.into('btp.toolkit.PlatformAccess').entries([
    { code: 'DEV', connectionMode: 'DIRECT', smUrl: `${tenant}/sm`, tokenUrl: `${tenant}/token`, clientId: 'sm',
      clientSecretEnc: encrypt('sm-secret'), cockpitUrl: 'https://cockpit.example', enabled: true },
    { code: 'PROD', connectionMode: 'DIRECT', enabled: false }
  ])
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
  await t.test('lists DEV endpoints (default tenant) with authentication and access role', async () => {
    const { status, body } = await call('listEndpoints()')
    assert.equal(status, 200)
    assert.deepEqual(body.endpoints.map((e: any) => [e.tenant, e.iflowId, e.iflowName, e.adapter, e.authentication, e.userRole, e.roleSource]), [
      // Legacy: no channel address matches the URL -> all sender channels; parameter not resolvable (no configuration)
      ['DEV', 'Legacy', 'Legacy SOAP', 'SOAP', 'RoleBased, ClientCertificate', '{{Sender Role}}', 'DESIGNTIME'],
      ['DEV', 'Orders', 'Orders API', 'HTTPS', 'RoleBased', 'Orders.Send', 'RUNTIME']
    ])
    assert.deepEqual(body.endpoints.map((e: any) => e.path), ['/cxf/legacy', '/http/orders/v1'])
    // PIRs granting the role; the unresolved parameter of Legacy is not a role
    assert.equal(body.pirsAvailable, true)
    assert.deepEqual(body.endpoints.map((e: any) => e.pirs), ['', 'pir-orders'])
    assert.deepEqual(body.messages, [])
  })

  await t.test('filters: iFlow, URL, adapter patterns; access roles can be skipped', async () => {
    const ids = async (q: string) => (await call(`listEndpoints(${q})`)).body.endpoints.map((e: any) => e.iflowId)
    assert.deepEqual(await ids(`tenant='DEV',iflow='orders*'`), ['Orders'])
    assert.deepEqual(await ids(`tenant='DEV',iflow='SOAP'`), ['Legacy']) // matches the name
    assert.deepEqual(await ids(`tenant='DEV',url=${lit('/cxf/*')}`), ['Legacy'])
    assert.deepEqual(await ids(`tenant='DEV',adapter='https'`), ['Orders'])
    const { body } = await call(`listEndpoints(tenant='DEV',iflow='Orders',accessRoles=false)`)
    assert.deepEqual(body.endpoints.map((e: any) => [e.userRole, e.roleSource]), [['', '']])
  })

  await t.test('filters: access role pattern (forces reading roles) and package', async () => {
    const ids = async (q: string) => (await call(`listEndpoints(${q})`)).body.endpoints.map((e: any) => e.iflowId)
    assert.deepEqual(await ids(`tenant='DEV',role='orders.send',accessRoles=false`), ['Orders'])
    assert.deepEqual(await ids(`tenant='DEV',packageId='Sales'`), ['Orders'])
    const { body } = await call(`listEndpoints(tenant='DEV',packageId='Nope')`)
    assert.deepEqual(body.endpoints, [])
    assert.deepEqual(body.messages.map((m: any) => m.level), ['ERROR'])
  })

  await t.test('packages value help; unconfigured tenant -> 412, bad tenant -> 400', async () => {
    const { body } = await call(`listPackages(tenant='DEV')`)
    assert.deepEqual(body.value.map((p: any) => p.id), ['Finance', 'Sales'])
    assert.equal((await call(`listEndpoints(tenant='PROD')`)).status, 412)
    assert.equal((await call(`listEndpoints(tenant='QA')`)).status, 400)
  })

  await t.test('details: deployment, matched sender channel with resolved role from the runtime artifact', async () => {
    const { status, body } = await call(`endpointDetails(tenant='DEV',iflowId='Orders',url=${lit(`${tenant}/http/orders/v1`)})`)
    assert.equal(status, 200)
    assert.deepEqual(body.deployment, { version: '1.0.4', status: 'STARTED', deployedBy: 'jane@example.com', deployedOn: '2025-10-09T08:53:20.000Z' })
    assert.equal(body.contentSource, 'RUNTIME')
    assert.equal(body.matched, true)
    assert.deepEqual(body.channels.map((c: any) => [c.adapter, c.userRole]), [['HTTPS', 'Orders.Send']])
    assert.equal(body.pirsAvailable, true)
    const [pir] = body.channels[0].pirs
    assert.equal(body.channels[0].pirs.length, 1)
    assert.deepEqual([pir.name, pir.plan, pir.matchedRoles, pir.grantTypes, pir.spaceName], ['pir-orders', '', ['Orders.Send'], ['client_credentials'], 'dev'])
    assert.equal(pir.cockpitLink, 'https://cockpit.example/#/globalaccount/ga1/subaccount/sa1/service-instances&//detail/i-orders/?layout=TwoColumnsMidExpanded')
  })

  await t.test('PIRs: listed from all pages, by plan or parameter shape, filtered by role pattern', async () => {
    const { status, body } = await call(`listPirs(tenant='DEV')`)
    assert.equal(status, 200)
    assert.deepEqual(body.pirs.map((p: any) => [p.name, p.plan, p.roles]), [
      ['pir-api', 'api', ['WorkspacePackagesRead']],
      ['pir-orders', '', ['Orders.Send', 'ESBMessaging.send']]
    ])
    assert.equal(hanaParamsRead, 0) // known non-PIR plans are skipped without reading parameters
    assert.ok(!JSON.stringify(body).includes('secret'))
    const filtered = await call(`listPirs(tenant='DEV',role='esb*')`)
    assert.deepEqual(filtered.body.pirs.map((p: any) => [p.name, p.matchedRoles]), [['pir-orders', ['ESBMessaging.send']]])
    assert.equal((await call(`listPirs(tenant='PROD')`)).status, 412)
    assert.equal((await call(`listPirs(tenant='QA')`)).status, 400)
  })

  await t.test('PIRs: disabled platform access hides them without failing the endpoint list', async () => {
    await UPDATE.entity('btp.toolkit.PlatformAccess').set({ enabled: false }).where({ code: 'DEV' })
    try {
      const { status, body } = await call(`listEndpoints(tenant='DEV',iflow='Orders')`)
      assert.equal(status, 200)
      assert.deepEqual([body.pirsAvailable, body.endpoints[0].pirs, body.messages], [false, '', []])
      const details = await call(`endpointDetails(tenant='DEV',iflowId='Orders',url=${lit(`${tenant}/http/orders/v1`)})`)
      assert.deepEqual([details.body.pirsAvailable, details.body.channels[0].pirs], [false, []])
    } finally {
      await UPDATE.entity('btp.toolkit.PlatformAccess').set({ enabled: true }).where({ code: 'DEV' })
    }
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
