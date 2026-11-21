import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { generateKeyPairSync, sign } from 'node:crypto'
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
  const received = []
  const server = createServer((req, res) => {
    requests.push([req.method, req.url, req.headers.authorization])
    received.push(performance.now())
    respond(req, res)
  })
  await once(server.listen(0, '127.0.0.1'), 'listening')
  t.after(async () => {
    await new Promise(resolve => server.close(resolve))
    await rm(cwd, { recursive: true, force: true })
  })
  const origin = `http://127.0.0.1:${server.address().port}`
  return {
    cwd, requests, received, origin,
    async run(endpoints, extra = {}, flags = [], overrides = {}, env = { FIXTURE_TOKEN: testToken }, command = 'check') {
      await writeFile(join(cwd, 'qa-guardian.config.json'), JSON.stringify({
        baseUrl: origin, checks: { pages: false, links: false, accessibility: false, api: false },
        failOn: 'warning', reportDir: 'reports',
        security: { authorized: true, origin, endpoints, ...extra }, ...overrides,
      }))
      const options = { cwd, env: { ...process.env, ...env } }
      try {
        const { stdout } = await execute(process.execPath, [cli, command, '--json', ...flags], options)
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
    Buffer.from('fixture').toString('base64url'),
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
    Buffer.from('fixture').toString('base64url'),
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

test('an unreadable JSON response leaves earlier body findings unverified', async t => {
  let body = '{"secret":"fixture"}'
  const app = await fixture(t, (_, res) => res.end(body))
  const checks = [endpoint('json', '/data', { sensitiveFields: [['secret']] })]
  const [saved, baseline] = await app.run(checks, {}, ['--save-baseline'])
  assert.equal(saved, 1)
  assert.equal(baseline.baselineSaved, true)
  body = 'temporarily unavailable'
  const [compared, report] = await app.run(checks, {}, ['--baseline'])
  assert.equal(compared, 1)
  assert.equal(report.regression.unverified.length, 1)
  assert.equal(report.regression.resolved.length, 0)
})

test('verifies JWT issuer, audience, expiration and pinned RSA signature without exposing token bytes', async t => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const claims = { exp: now + 300, iat: now - 1, nbf: now - 1, iss: 'test-issuer', aud: ['test-audience'] }
  const compact = (payload, algorithm = 'RS256') => {
    const data = `${encoded({ alg: algorithm })}.${encoded(payload)}`
    return data + '.' + sign('sha256', Buffer.from(data), privateKey).toString('base64url')
  }
  let token = compact(claims)
  const app = await fixture(t, (_, res) => res.end(JSON.stringify({ token })))
  const config = [endpoint('verified', '/session', {
    jwt: {
      path: ['token'], issuer: 'test-issuer', audience: 'test-audience', maxLifetimeSeconds: 600,
      verification: { algorithm: 'RS256', publicKeyEnv: 'FIXTURE_PUBLIC_KEY' },
    },
  })]
  const env = { FIXTURE_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }) }
  assert.equal((await app.run(config, {}, [], {}, env))[0], 0)
  for (const [candidate, message] of [
    [compact({ ...claims, iss: 'wrong' }), /issuer/],
    [compact({ ...claims, aud: ['wrong'] }), /audience/],
    [compact({ ...claims, exp: now - 1 }), /expiration/],
    [compact({ ...claims, nbf: now + 60 }), /not-before/],
    [compact(claims, 'HS256'), /signature/],
    [compact(claims).replace(/\.[^.]+$/, '.ZmFrZQ'), /signature/],
  ]) {
    token = candidate
    const [code, report, text] = await app.run(config, {}, [], {}, env)
    assert.equal(code, 1)
    assert.match(report.results[0].message, message)
    assert.ok(!text.includes(candidate))
  }
  const before = app.requests.length
  assert.equal((await app.run(config, {}, [], {}, { FIXTURE_PUBLIC_KEY: 'invalid' }))[0], 2)
  assert.equal(app.requests.length, before)
})

test('checks observed CORS allowlists, session cookie attributes and rate-limit header syntax', async t => {
  let secure = false
  const secret = 'test-session-secret'
  const app = await fixture(t, (_, res) => {
    res.writeHead(200, {
      'access-control-allow-methods': secure ? 'GET' : 'GET, DELETE',
      'access-control-allow-headers': secure ? 'Content-Type' : 'Content-Type, Authorization',
      'set-cookie': [`session=${secret}${secure ? '; Secure; HttpOnly; SameSite=Lax' : ''}`],
      'retry-after': secure ? '30' : 'unexpected value',
      'x-ratelimit-limit': '10', 'x-ratelimit-remaining': secure ? '0' : '11',
      'referrer-policy': secure ? 'strict-origin-when-cross-origin' : 'unknown',
    })
    res.end(secure ? 'ok' : ['-----BEGIN', 'PRIVATE KEY-----'].join(' '))
  })
  const checks = [endpoint('policy', '/account', {
    corsMethods: ['GET'], corsHeaders: ['content-type'], cookies: [{ name: 'session', sameSite: 'Lax' }],
    expectRateLimitHeaders: true, inspectCredentialMarkers: true, expectHeaders: ['referrer-policy'],
  })]
  const [code, report, text] = await app.run(checks)
  assert.equal(code, 1)
  assert.deepEqual(report.results.map(item => item.issue).sort(), [
    'policy:access-control-allow-headers', 'policy:access-control-allow-methods', 'policy:cookie-attributes',
    'policy:credential-marker', 'policy:rate-limit-budget', 'policy:referrer-policy', 'policy:retry-after-format',
  ])
  assert.ok(!text.includes(secret))
  secure = true
  assert.equal((await app.run(checks))[0], 0)
})

test('security-only command checks fixed object paths with separately supplied identities', async t => {
  const app = await fixture(t, (req, res) => {
    res.writeHead(req.headers.authorization === `Bearer ${testToken}` ? 200 : req.headers.authorization ? 403 : 401)
    res.end()
  })
  const resource = '/accounts/test-resource'
  const checks = [
    endpoint('anonymous', resource, { expectedStatus: 401 }),
    endpoint('owner', resource, { bearerTokenEnv: 'FIXTURE_TOKEN' }),
    endpoint('unrelated', resource, { expectedStatus: 403, bearerTokenEnv: 'FIXTURE_OTHER' }),
  ]
  const [code] = await app.run(checks, { intervalMs: 15 }, [], { checks: { pages: true } }, {
    FIXTURE_TOKEN: testToken, FIXTURE_OTHER: 'other-test-token',
  }, 'security')
  assert.equal(code, 0)
  assert.deepEqual(app.requests.map(item => item[1]), [resource, resource, resource])
  assert.ok(app.received[2] - app.received[0] >= 25)
})
