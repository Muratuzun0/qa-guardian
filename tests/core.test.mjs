import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { baselineScope, compareBaseline, loadBaseline, saveBaseline } from '../dist/baseline.js'
import { loadConfig, resolveHeaders, validateConfig } from '../dist/config.js'
import { parseTarget, safeUrl } from '../dist/network.js'
import { formatJson, formatTerminal, report, result, writeReport } from '../dist/report.js'

const baseUrl = 'http://localhost:3000'
const start = performance.now()
const finding = (details = {}, message = 'Endpoint unavailable') =>
  result('api', 'fail', start, message, { issue: 'status-GET-200', url: baseUrl + '/api', ...details })

async function directory(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'qa-guardian-unit-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  return cwd
}

test('defaults enable website checks and leave API endpoints explicit', async t => {
  const cwd = await directory(t)
  const config = await loadConfig(cwd)
  assert.equal(config.baseUrl, baseUrl + '/')
  assert.deepEqual(config.routes, ['/'])
  assert.deepEqual(config.checks, { pages: true, links: true, accessibility: true, api: true })
  assert.deepEqual(config.links.externalOrigins, [])
  assert.deepEqual(config.api, [])
  assert.equal(config.failOn, 'error')
  assert.equal((await loadConfig(cwd, undefined, 'https://example.test')).baseUrl, 'https://example.test/')
  await assert.rejects(loadConfig(cwd, 'explicit.json', baseUrl), /Could not read/)
})

test('config validates origin, limits, methods and paths without echoing sensitive values', () => {
  for (const options of [
    { baseUrl: 'http://private-secret@example.test' },
    { baseUrl: 'https://example.test/#token' },
    { routes: ['//elsewhere.test/'] },
    { timeoutMs: 0 },
    { links: { externalOrigins: ['https://example.test/path'] } },
    { links: { concurrency: 17 } },
    { api: [{ path: '/orders', method: 'DELETE' }] },
    { api: [{ path: '/orders', headers: { 'Keep-Alive': 'on' } }] },
    { api: [{ path: '/orders', method: 'HEAD', assertions: [{ path: ['ok'], equals: true }] }] },
    { reportDir: 'reports/../escape' },
    { reportDir: '.git/reports' },
    { privateSecret: true },
  ]) {
    assert.throws(() => validateConfig({ baseUrl, ...options }), error => {
      assert.doesNotMatch(error.message, /private-secret|privateSecret/)
      return true
    })
  }
  assert.equal(validateConfig({ baseUrl, allowUnsafeMethods: true, api: [{ path: '/orders', method: 'DELETE' }] }).api[0].method, 'DELETE')
})

test('API headers resolve only complete environment references and reject unsafe values', t => {
  const env = 'QAG_CONFIG_UNIT_SECRET'
  const original = process.env[env]
  t.after(() => {
    if (original === undefined) delete process.env[env]
    else process.env[env] = original
  })
  delete process.env[env]
  const reference = '${' + env + '}'
  assert.throws(() => resolveHeaders({ Authorization: reference }), /missing or empty/)
  process.env[env] = 'Bearer abc'
  assert.equal(resolveHeaders({ Authorization: reference }).Authorization, 'Bearer abc')
  assert.equal(resolveHeaders({ Authorization: 'prefix ' + reference }).Authorization, 'prefix ' + reference)
  process.env[env] = 'invalid\nheader'
  assert.throws(() => resolveHeaders({ Authorization: reference }), /invalid/)
})

test('normalizes URLs, rejects credentials and omits report queries and fragments', () => {
  const target = parseTarget('../next?api_key=private#part', new URL(baseUrl + '/section/'))
  assert.equal(target.href, baseUrl + '/next?api_key=private#part')
  assert.equal(safeUrl(target), baseUrl + '/next')
  assert.throws(() => parseTarget('https://example.test\n/a'), /control/)
  assert.throws(() => parseTarget('https://user:pw@example.test/'), /without credentials/)
  assert.throws(() => parseTarget('file:///etc/hosts'), /HTTP/)
})

test('reports aggregate results, respect thresholds, and exclude secrets and terminal controls', () => {
  const warning = finding({ severity: 'warning' }, 'warning\u001b[31m secret-token')
  const output = report([warning, result('pages', 'pass', start, 'ok')], 'error', ['secret-token'])
  assert.deepEqual(output.summary, { pass: 1, fail: 1, skipped: 0, error: 0 })
  assert.equal(output.exitCode, 0)
  assert.equal(report([warning], 'warning').exitCode, 1)
  assert.equal(report([warning, result('execution', 'error', start, 'error')], 'warning').exitCode, 2)
  const terminal = formatTerminal(output)
  assert.match(terminal, /Severity: warning/)
  assert.match(terminal, /1 passed, 1 failed/)
  assert.doesNotMatch(terminal, /secret-token|\u001b/)
  assert.deepEqual(JSON.parse(formatJson(output)).summary, output.summary)
})

test('fingerprints remain stable across message changes and classify incomplete coverage', () => {
  const first = report([finding()], 'error')
  const same = report([finding({}, 'Different status explanation')], 'error')
  assert.equal(first.results[0].fingerprint, same.results[0].fingerprint)
  const previous = [{ ...first.results[0] }]
  const unchanged = compareBaseline(same, previous, 'error')
  assert.equal(unchanged.exitCode, 0)
  assert.equal(unchanged.regression.unchanged.length, 1)
  const incomplete = report([result('api', 'skipped', start, 'Skipped', { url: baseUrl + '/api', coverageIncomplete: true })], 'error')
  assert.equal(compareBaseline(incomplete, previous, 'error').regression.unverified.length, 1)
  const extra = report([finding({ issue: 'assertion-GET-200', severity: 'warning' })], 'warning')
  const diff = compareBaseline(extra, previous, 'warning')
  assert.equal(diff.exitCode, 1)
  assert.equal(diff.regression.resolved.length, 1)
  assert.equal(diff.regression.new.length, 1)
})

test('baseline scope ignores threshold and route order but detects configured coverage changes', () => {
  const get = options => baselineScope(validateConfig({ baseUrl, ...options }))
  assert.equal(get({ routes: ['/a', '/b'] }), get({ routes: ['/b', '/a'], failOn: 'warning' }))
  assert.notEqual(get({ routes: ['/a'] }), get({ routes: ['/a', '/b'] }))
  assert.notEqual(get({ checks: { links: true } }), get({ checks: { links: false } }))
  assert.notEqual(get({ api: [{ path: '/health', expectedStatus: 200 }] }), get({ api: [{ path: '/health', expectedStatus: 204 }] }))
})

test('baseline writes are exclusive and reject incomplete coverage', async t => {
  const cwd = await directory(t)
  const config = validateConfig({ baseUrl })
  const scope = baselineScope(config)
  const unhealthy = report([finding()], 'error')
  const incomplete = report([result('links', 'skipped', start, 'Skipped', { coverageIncomplete: true })], 'error')
  await assert.rejects(saveBaseline(cwd, scope, incomplete), /incomplete/)
  await saveBaseline(cwd, scope, unhealthy)
  const saved = await loadBaseline(cwd, scope)
  assert.equal(saved[0].fingerprint, unhealthy.results[0].fingerprint)
  await assert.rejects(saveBaseline(cwd, scope, report([], 'error')), /already exists/)
  await assert.rejects(loadBaseline(cwd, baselineScope(validateConfig({ baseUrl, routes: ['/elsewhere'] }))), /different check/)
  assert.deepEqual(await loadBaseline(cwd, scope), saved)
})

test('report writes replace existing file atomically, while directory-file collisions fail', async t => {
  const cwd = await directory(t)
  const output = report([finding()], 'error')
  await mkdir(join(cwd, 'reports'))
  await writeFile(join(cwd, 'reports', 'qa-guardian-report.json'), 'old')
  await writeReport(cwd, 'reports', output)
  assert.equal(await readFile(join(cwd, 'reports', 'qa-guardian-report.json'), 'utf8'), formatJson(output))
  await writeFile(join(cwd, 'regular-file'), '')
  await assert.rejects(writeReport(cwd, 'regular-file/nested', output), /directory|symlinks/i)
})
