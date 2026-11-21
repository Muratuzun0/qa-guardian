import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
const execute = promisify(execFile)
const testToken = 'example-test-bearer-12345'
const endpoint = (id, path, attributes = {}) => ({ id, path, expectedStatus: 200, ...attributes })

async function fixture(t, respond) {
  const cwd = await mkdtemp(join(tmpdir(), 'qa-guardian-security-'))
  const requests = []
  const server = createServer((req, res) => {
    requests.push([req.method, req.url, req.headers.authorization])
    respond(req, res)
  })
  await once(server.listen(0, '127.0.0.1'), 'listening')
  t.after(async () => {
    await new Promise(resolve => server.close(resolve))
    await rm(cwd, { recursive: true, force: true })
  })
  const origin = `http://127.0.0.1:${server.address().port}`
  return {
    cwd, requests, origin,
    async run(endpoints, extra = {}, flags = [], overrides = {}, env = { FIXTURE_TOKEN: testToken }) {
      await writeFile(join(cwd, 'qa-guardian.config.json'), JSON.stringify({
        baseUrl: origin, checks: { pages: false, links: false, accessibility: false, api: false },
        failOn: 'warning', reportDir: 'reports',
        security: { authorized: true, origin, endpoints, ...extra }, ...overrides,
      }))
      const options = { cwd, env: { ...process.env, ...env } }
      try {
        const { stdout } = await execute(process.execPath, [cli, 'check', '--json', ...flags], options)
        return [0, JSON.parse(stdout), stdout]
      } catch (error) {
        return [error.code, JSON.parse(error.stdout), error.stdout]
      }
    },
  }
}

test('security is opt-in and rejects out-of-scope targets or oversized budgets before network activity', async t => {
  const app = await fixture(t, () => assert.fail('Unexpected request'))
  const normal = endpoint('normal', '/account')
  for (const [items, extra, override] of [
    [[normal], {}, { security: undefined }],
    [[normal], { authorized: false }],
    [[normal], { origin: 'https://example.test' }],
    [[normal, normal], { requestBudget: 1 }],
    [[endpoint('other', '//example.test/x')]],
    [[endpoint('method', '/x', { method: 'POST' })]],
    [[normal], {}, { baseUrl: 'http://example.test' }],
  ]) {
    const [code] = await app.run(items, extra, [], override)
    assert.equal(code, override && 'security' in override ? 0 : 2)
  }
  assert.equal(app.requests.length, 0)
})

test('configured anonymous and authorized scenarios compare status without reporting credentials', async t => {
  const app = await fixture(t, (req, res) => {
    res.writeHead(req.headers.authorization === `Bearer ${testToken}` ? 200 : 401)
    res.end()
  })
  const identities = [
    endpoint('anonymous', '/account', { expectedStatus: 401 }),
    endpoint('member', '/account', { bearerTokenEnv: 'FIXTURE_TOKEN' }),
  ]
  const [code, pass] = await app.run(identities)
  assert.equal(code, 0)
  assert.equal(pass.summary.pass, 2)
  assert.deepEqual(app.requests, [['GET', '/account', undefined], ['GET', '/account', `Bearer ${testToken}`]])
  const [failed, report, stdout] = await app.run([{ ...identities[1], expectedStatus: 403 }])
  assert.equal(failed, 1)
  assert.equal(report.results[0].issue, 'member:status')
  assert.equal(report.results[0].confidence, 'observed')
  assert.ok(!stdout.includes(testToken))
  const [invalid] = await app.run(identities, {}, [], {}, { FIXTURE_TOKEN: '' })
  assert.equal(invalid, 2)
  assert.equal(app.requests.length, 3)
})

test('observes CORS, cache policy, SQL diagnostic disclosure, and JWT metadata without storing response values', async t => {
  const token = [
    Buffer.from('{"alg":"RS256"}').toString('base64url'),
    Buffer.from('{"exp":1}').toString('base64url'),
    'fake-signature',
  ].join('.')
  const secret = 'private-response-value'
  const app = await fixture(t, (_, res) => {
    res.writeHead(200, {
      'content-type': 'application/json', 'access-control-allow-origin': '*',
      'access-control-allow-credentials': 'true',
    })
    res.end(JSON.stringify({ privateKey: secret, token, error: 'SQLSTATE[HY000] hidden diagnostic' }))
  })
  const checks = [endpoint('account', '/account', {
    sensitive: true, expectHeaders: ['content-security-policy', 'x-content-type-options', 'strict-transport-security'],
    inspectDiagnostics: true, sensitiveFields: [['privateKey']], jwt: { path: ['token'], algorithms: ['RS256'] },
  })]
  const [code, report, text] = await app.run(checks, {}, ['--save-baseline'])
  assert.equal(code, 1)
  assert.equal(report.baselineSaved, true)
  assert.deepEqual(report.results.map(item => item.issue).sort(), [
    'account:diagnostic-disclosure', 'account:jwt-metadata', 'account:origin-policy',
    'account:sensitive-cache', 'account:sensitive-field', 'account:x-content-type-options',
  ])
  assert.equal(report.results.find(result => result.category === 'disclosure').confidence, 'heuristic')
  const diskReport = await readFile(join(app.cwd, 'reports/qa-guardian-report.json'), 'utf8')
  const baseline = await readFile(join(app.cwd, '.qa-guardian-baseline.json'), 'utf8')
  for (const output of [text, diskReport, baseline]) {
    for (const value of [token, secret, 'hidden diagnostic']) assert.ok(!output.includes(value))
  }
  const [compared, comparison] = await app.run(checks, {}, ['--baseline'])
  assert.equal(compared, 0)
  assert.equal(comparison.regression.unchanged.length, 6)
})

test('does not follow redirects and halts requests on rate limiting', async t => {
  const app = await fixture(t, (req, res) => {
    if (req.url === '/redirect') res.writeHead(302, { location: '/unexpected' })
    else res.writeHead(429, { 'retry-after': '30' })
    res.end()
  })
  const [code, report] = await app.run([
    endpoint('redirect', '/redirect', { expectedStatus: 302 }),
    endpoint('rate', '/rate', { expectedStatus: 429 }),
    endpoint('skipped', '/unexpected'),
  ])
  assert.equal(code, 0)
  assert.equal(report.results[2].coverageIncomplete, true)
  assert.deepEqual(app.requests.map(item => item[1]), ['/redirect', '/rate'])
})

test('timeouts, response limits, and non-public addresses are explicit execution errors', async t => {
  const app = await fixture(t, (req, res) => {
    if (req.url === '/large') res.end('x'.repeat(270_000))
  })
  const [timeout, slow] = await app.run([endpoint('slow', '/slow')], { timeoutMs: 25 })
  assert.equal(timeout, 2)
  assert.match(slow.results[0].message, /timed out/)
  const [large, bounded] = await app.run([endpoint('large', '/large', { inspectDiagnostics: true })])
  assert.equal(large, 2)
  assert.match(bounded.results[0].message, /byte limit/)
  for (const blocked of ['https://10.0.0.1', 'https://localhost']) {
    const [denied, deniedReport] = await app.run([endpoint('blocked', '/account')], { origin: blocked }, [], { baseUrl: blocked })
    assert.equal(denied, 2)
    assert.match(deniedReport.results[0].message, /non-public/)
  }
})

test('valid JWT metadata and a noncredentialed public CORS response pass their configured expectations', async t => {
  const now = Math.floor(Date.now() / 1000)
  const fixtureToken = [
    Buffer.from('{"alg":"RS256"}').toString('base64url'),
    Buffer.from(JSON.stringify({ iat: now - 2, nbf: now - 1, exp: now + 60, sub: 'test-user' })).toString('base64url'),
    'fixture-signature',
  ].join('.')
  const app = await fixture(t, (_, res) => {
    res.writeHead(200, {
      'content-type': 'application/json', 'access-control-allow-origin': '*',
      'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store',
    })
    res.end(JSON.stringify({ token: fixtureToken, message: 'Expected fixture data' }))
  })
  const [code, report, text] = await app.run([endpoint('public', '/metadata', {
    sensitive: true,
    sensitiveFields: [['internal', 'password']],
    inspectDiagnostics: true,
    expectHeaders: ['x-content-type-options'],
    jwt: { path: ['token'], algorithms: ['RS256'], requiredClaims: ['sub', 'exp'], maxLifetimeSeconds: 90 },
  })])
  assert.equal(code, 0)
  assert.equal(report.summary.pass, 1)
  assert.ok(!text.includes(fixtureToken))
})
