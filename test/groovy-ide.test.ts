import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer, type Server } from 'node:http'
import { crc32, deflateRawSync } from 'node:zlib'
import cds from '@sap/cds'
import { encrypt } from '../srv/lib/crypto.js'
import { readZip } from '../srv/lib/zip.js'
import { bodiesMatch, buildRequest, encodeMap, parseMap, parseResponse } from '../srv/features/groovy-ide/contract.js'

const { UPDATE } = cds.ql
let app: Server
let upstream: Server
let base: string
let tenant: string
let runnerCalls = 0

const SCRIPT_PATH = 'src/main/resources/script/transform.groovy'
const SCRIPT_TEXT = 'def Message processData(Message message) { return message }'

/** Minimal ZIP writer (one deflated, one stored entry) to feed the reader like a CPI export. */
function zip(files: { path: string; content: string; store?: boolean }[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const f of files) {
    const raw = Buffer.from(f.content)
    const data = f.store ? raw : deflateRawSync(raw)
    const name = Buffer.from(f.path)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(f.store ? 0 : 8, 8)
    local.writeUInt32LE(crc32(raw), 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 6); central.writeUInt16LE(f.store ? 0 : 8, 10)
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

const b64 = (s: string) => Buffer.from(s).toString('base64')
const unb64 = (s: string) => Buffer.from(s ?? '', 'base64').toString('utf8')

/** Fake runner iFlow: same JSON contract as the blog; "executes" by upper-casing the payload. */
function runner(body: any) {
  runnerCalls++
  const script = unb64(body.inputScript)
  const props = unb64(body.inputParams).split(';').filter(Boolean).map(p => p.split('=')).map(([k, v]) => `${k} = ${v};`).join('')
  const hdrs = unb64(body.inputHdrs).split(';').filter(Boolean).map(p => p.split('=')).map(([k, v]) => `${k} = ${v};`).join('')
  const allProps = `${props}inputScript = ${body.inputScript};`
  if (script.includes('boom')) {
    return [400, { properties: b64(allProps), headers: b64(hdrs), payload: b64(unb64(body.inputPayload)), error: b64('java.lang.ArithmeticException: Division by zero @ line 7') }]
  }
  const payload = script.includes('BTP CI Toolkit executor test') ? 'BTP CI Toolkit executor test' : unb64(body.inputPayload).toUpperCase()
  return [200, {
    properties: b64(allProps), headers: b64(`${hdrs}Content-Type = application/json; charset=utf-8;`),
    payload: b64(payload), console: b64('hello\n')
  }]
}

before(async () => {
  const artifactZip = zip([
    { path: 'META-INF/MANIFEST.MF', content: 'Manifest-Version: 1.0' },
    { path: SCRIPT_PATH, content: SCRIPT_TEXT },
    { path: 'src/main/resources/script/helper.groovy', content: '// stored', store: true }
  ])
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
    if (request.method === 'POST' && url === '/http/runner') {
      let raw = ''
      request.on('data', c => { raw += c })
      request.on('end', () => {
        const [status, json] = runner(JSON.parse(raw))
        response.writeHead(status as number, { 'Content-Type': 'application/json' }).end(JSON.stringify(json))
      })
      return
    }
    response.setHeader('Content-Type', 'application/json')
    const ok = (d: unknown) => response.end(JSON.stringify({ d }))
    if (url.startsWith("/api/v1/IntegrationPackages('P1')/IntegrationDesigntimeArtifacts")) ok({ results: [{ Id: 'IF1', Name: 'Flow 1', Version: '1.0.3' }] })
    else if (url.startsWith("/api/v1/IntegrationPackages('P1')/ScriptCollectionDesigntimeArtifacts")) ok({ results: [] })
    else if (url.startsWith('/api/v1/IntegrationPackages')) ok({ results: [{ Id: 'P1', Name: 'Package 1' }] })
    else if (url.startsWith("/api/v1/IntegrationDesigntimeArtifacts(Id='IF1',Version='active')/$value")) {
      response.setHeader('Content-Type', 'application/zip')
      response.end(artifactZip)
    } else if (url.startsWith("/api/v1/IntegrationDesigntimeArtifacts(Id='IF1',Version='active')")) response.writeHead(501).end()
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

async function call(path: string, method = 'GET', data?: unknown, user = 'alice') {
  const response = await fetch(`${base}/odata/v4/${path}`, {
    method,
    headers: { Authorization: `Basic ${Buffer.from(`${user}:${user}`).toString('base64')}`, 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data)
  })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : undefined }
}

test('runner contract helpers', () => {
  assert.equal(encodeMap([{ name: 'a', value: '1' }, { name: ' ', value: 'x' }, { name: 'b', value: '' }], 'Header'), 'a=1;b=')
  assert.throws(() => encodeMap([{ name: 'a', value: 'x;y' }], 'Header'), /must not contain/)
  assert.deepEqual(JSON.parse(JSON.stringify(buildRequest({ script: 's', payload: 'p' }))),
    { inputScript: b64('s'), inputPayload: b64('p'), inputParams: '', inputHdrs: '' })
  assert.deepEqual(parseMap('Content-Type = application/json; charset=utf-8;CamelHttpResponseCode = 200; \nx = ;'), [
    { name: 'Content-Type', value: 'application/json; charset=utf-8' },
    { name: 'CamelHttpResponseCode', value: '200' },
    { name: 'x', value: '' }
  ])
  const failed = parseResponse(400, JSON.stringify({ payload: b64('in'), properties: b64('inputScript = abc;p = 1;'), headers: '', error: b64('oops') }))
  assert.equal(failed.success, false)
  assert.equal(failed.error, 'oops')
  assert.deepEqual(failed.properties, [{ name: 'p', value: '1' }])
  assert.match(parseResponse(500, '<html/>').error, /HTTP 500/)
  assert.match(parseResponse(200, '<html/>').error, /unexpected response format/)
  assert.ok(bodiesMatch('{"a":1,"b":[1,2]}', '{ "b": [1, 2], "a": 1 }', 'JSON'))
  assert.ok(bodiesMatch('<?xml version="1.0"?>\n<a>\n  <b>1</b>\n</a>', '<a><b>1</b></a>', 'XML'))
  assert.ok(bodiesMatch('x\r\n', 'x', 'TRIMMED'))
  assert.ok(!bodiesMatch('x\n', 'x', 'EXACT'))
  assert.deepEqual(readZip(zip([{ path: 'a/b.groovy', content: 'abc' }, { path: 'c.txt', content: 'd', store: true }]))
    .map(e => [e.path, e.read().toString()]), [['a/b.groovy', 'abc'], ['c.txt', 'd']])
})

test('groovy IDE service', async t => {
  let scriptId = ''

  await t.test('roles: viewer reads, developer writes and runs, executor settings are admin only', async () => {
    assert.equal((await call('groovy-ide/Scripts', 'GET', undefined, 'bob')).status, 200)
    assert.equal((await call('groovy-ide/Scripts', 'POST', { name: 'x' }, 'bob')).status, 403)
    assert.equal((await call('groovy-ide/run', 'POST', { script: 'x' }, 'bob')).status, 403)
    assert.equal((await call('config/ScriptExecutor', 'GET', undefined, 'bob')).status, 403)
    assert.deepEqual((await call('groovy-ide/executorStatus()', 'GET', undefined, 'bob')).body,
      { '@odata.context': '$metadata#GroovyIdeService.ExecutorStatus', enabled: false, canRun: false })
  })

  await t.test('run is rejected until the executor is enabled', async () => {
    const res = await call('groovy-ide/run', 'POST', { script: 'x' })
    assert.equal(res.status, 412)
    assert.equal(runnerCalls, 0)
  })

  await t.test('admin configures the executor through the draft flow, secret is write-only, test runs a script', async () => {
    const list = await call('config/ScriptExecutor')
    assert.equal(list.status, 200)
    assert.equal(list.body.value.length, 1)
    assert.equal(list.body.value[0].secretSet, false)
    assert.ok(!('clientSecretEnc' in list.body.value[0]))
    const key = "ScriptExecutor(code='DEFAULT',IsActiveEntity=true)"
    assert.equal((await call(`config/${key}/ConfigService.draftEdit`, 'POST', { PreserveChanges: false })).status, 201)
    const draft = "ScriptExecutor(code='DEFAULT',IsActiveEntity=false)"
    assert.equal((await call(`config/${draft}`, 'PATCH', { endpointUrl: 'ftp://bad' })).status, 200)
    assert.equal((await call(`config/${draft}/ConfigService.draftActivate`, 'POST', {})).status, 400)
    assert.equal((await call(`config/${draft}`, 'PATCH', {
      endpointUrl: `${tenant}/http/runner`, tokenUrl: `${tenant}/token`, clientId: 'runner', enabled: true
    })).status, 200)
    assert.equal((await call(`config/${draft}/ConfigService.draftActivate`, 'POST', {})).status, 200)
    assert.equal((await call(`config/${key}/ConfigService.setSecret`, 'POST', { secret: 'runner-secret' })).status, 200)
    const tested = await call(`config/${key}/ConfigService.test`, 'POST', {})
    assert.equal(tested.status, 200)
    assert.equal(tested.body.ok, true, tested.body.message)
    const after = (await call(`config/${key}`)).body
    assert.equal(after.secretSet, true)
    assert.equal(after.lastTestOk, true)
    assert.ok(!JSON.stringify(after).includes('runner-secret'))
  })

  await t.test('run returns decoded output; Groovy errors come back as success=false', async () => {
    const ok = await call('groovy-ide/run', 'POST', {
      script: 'println "hello"', payload: 'abc',
      headers: [{ name: 'h1', value: 'v1' }], properties: [{ name: 'p1', value: 'x' }]
    })
    assert.equal(ok.status, 200)
    assert.equal(ok.body.success, true)
    assert.equal(ok.body.body, 'ABC')
    assert.equal(ok.body.console, 'hello\n')
    assert.deepEqual(ok.body.properties, [{ name: 'p1', value: 'x' }])
    assert.deepEqual(ok.body.headers, [{ name: 'h1', value: 'v1' }, { name: 'Content-Type', value: 'application/json; charset=utf-8' }])
    const failed = await call('groovy-ide/run', 'POST', { script: 'boom', payload: 'abc' })
    assert.equal(failed.body.success, false)
    assert.equal(failed.body.httpStatus, 400)
    assert.match(failed.body.error, /Division by zero/)
    const invalid = await call('groovy-ide/run', 'POST', { script: 'x', headers: [{ name: 'a', value: 'b;c' }] })
    assert.equal(invalid.body.success, false)
    assert.match(invalid.body.error, /must not contain/)
  })

  await t.test('download lists DEV artifacts and returns Groovy files from the zip', async () => {
    const packages = await call('groovy-ide/listPackages()')
    assert.deepEqual(packages.body.value, [{ id: 'P1', name: 'Package 1' }])
    const artifacts = await call("groovy-ide/listArtifacts(packageId='P1')")
    assert.deepEqual(artifacts.body.value, [{ id: 'IF1', name: 'Flow 1', type: 'IFLOW', version: '1.0.3' }])
    const scripts = await call("groovy-ide/listArtifactScripts(packageId='P1',type='IFLOW',artifactId='IF1')", 'GET', undefined, 'bob')
    assert.equal(scripts.status, 200)
    assert.equal(scripts.body.version, '1.0.3')
    assert.deepEqual(scripts.body.scripts.map((s: any) => s.path), ['src/main/resources/script/helper.groovy', SCRIPT_PATH])
    assert.equal(scripts.body.scripts[1].content, SCRIPT_TEXT)
    assert.equal((await call("groovy-ide/listArtifactScripts(packageId='P1',type='IFLOW',artifactId='NOPE')")).status, 404)
  })

  await t.test('scripts, versions and test cases are stored; runTests compares bodies', async () => {
    const created = await call('groovy-ide/Scripts', 'POST', {
      name: 'transform', content: SCRIPT_TEXT, sourceType: 'IFLOW', sourceTenant: 'DEV', sourceArtifactId: 'IF1', sourcePath: SCRIPT_PATH
    })
    assert.equal(created.status, 201)
    scriptId = created.body.ID
    assert.equal(created.body.createdBy, 'alice')
    const v1 = await call(`groovy-ide/Scripts(${scriptId})/GroovyIdeService.saveVersion`, 'POST', { comment: 'first' })
    assert.equal(v1.body.version, 1)
    const v2 = await call(`groovy-ide/Scripts(${scriptId})/GroovyIdeService.saveVersion`, 'POST', { comment: null, content: 'v2 text' })
    assert.equal(v2.body.version, 2)
    assert.equal((await call(`groovy-ide/Scripts(${scriptId})`)).body.content, 'v2 text')
    const versions = await call(`groovy-ide/Scripts(${scriptId})/versions?$orderby=version`)
    assert.deepEqual(versions.body.value.map((v: any) => [v.version, v.content]), [[1, SCRIPT_TEXT], [2, 'v2 text']])
    assert.equal((await call(`groovy-ide/Scripts(${scriptId})/GroovyIdeService.saveVersion`, 'POST', {}, 'bob')).status, 403)

    for (const tc of [
      { name: 'a pass', payload: 'abc', expectedBody: 'ABC\n', compareMode: 'TRIMMED' },
      { name: 'b fail', payload: 'abc', expectedBody: 'abc', compareMode: 'EXACT' },
      { name: 'c none', payload: 'x', headers: JSON.stringify([{ name: 'h', value: '1' }]) }
    ]) {
      assert.equal((await call(`groovy-ide/Scripts(${scriptId})/testCases`, 'POST', tc)).status, 201)
    }
    assert.equal((await call(`groovy-ide/Scripts(${scriptId})/testCases`, 'POST', { name: 'bad', headers: '{' })).status, 400)
    const results = await call('groovy-ide/runTests', 'POST', { scriptId, script: 'println 1', testCaseIds: [] })
    assert.deepEqual(results.body.value.map((r: any) => [r.name, r.status]), [['a pass', 'PASSED'], ['b fail', 'FAILED'], ['c none', 'NO_EXPECTATION']])
    const errored = await call('groovy-ide/runTests', 'POST', { scriptId, script: 'boom', testCaseIds: [results.body.value[0].testCaseId] })
    assert.deepEqual(errored.body.value.map((r: any) => r.status), ['ERROR'])

    assert.equal((await call(`groovy-ide/Scripts(${scriptId})`, 'DELETE')).status, 204)
    assert.equal((await call('groovy-ide/ScriptVersions')).body.value.length, 0)
    assert.equal((await call('groovy-ide/TestCases')).body.value.length, 0)
  })
})
