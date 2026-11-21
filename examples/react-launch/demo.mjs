import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createDemoServer } from './server.mjs'

const manifestUrl = new URL(import.meta.resolve('@muratuzun0/qa-guardian/package.json'))
const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'))
const cli = fileURLToPath(new URL(manifest.bin['qa-guardian'], manifestUrl))
const config = fileURLToPath(new URL('./qa-guardian.config.json', import.meta.url))
const execute = promisify(execFile)
const workspace = await mkdtemp(join(tmpdir(), 'qa-guardian-react-demo-'))
let revised = false
const server = createDemoServer(() => revised)

async function runCheck(baseUrl, option) {
  const args = [cli, 'check', '--config', config, '--url', baseUrl, option, '--json']
  try {
    const { stdout } = await execute(process.execPath, args, { cwd: workspace })
    return { exit: 0, report: JSON.parse(stdout) }
  } catch (error) {
    if (error.code !== 1) throw error
    return { exit: 1, report: JSON.parse(error.stdout) }
  }
}

function finding(item) {
  return `${item.check} ${new URL(item.url).pathname}: ${item.rule ?? item.message}`
}

try {
  await once(server.listen(0, '127.0.0.1'), 'listening')
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const baseline = await runCheck(baseUrl, '--save-baseline')
  assert.equal(baseline.exit, 1)
  assert.equal(baseline.report.baselineSaved, true)
  const findings = baseline.report.results.filter(item => item.status === 'fail').map(finding).sort()
  assert.deepEqual(findings, ['accessibility /: image-alt', 'links /workshop-recording: Link returned HTTP 404.'])
  for (const check of ['pages', 'api']) {
    assert.ok(baseline.report.results.some(item => item.check === check && item.status === 'pass'))
  }
  console.log(`Baseline (exit ${baseline.exit})`)
  for (const item of findings) console.log(`  ${item}`)

  revised = true
  const comparison = await runCheck(baseUrl, '--baseline')
  assert.equal(comparison.exit, 1)
  const expected = {
    new: ['links /partner-guide: Link returned HTTP 404.'],
    resolved: ['accessibility /: image-alt'],
    unchanged: ['links /workshop-recording: Link returned HTTP 404.'],
    unverified: [],
  }
  console.log(`Comparison (exit ${comparison.exit})`)
  for (const [status, items] of Object.entries(expected)) {
    const actual = comparison.report.regression[status].map(finding).sort()
    assert.deepEqual(actual, items)
    for (const item of actual) console.log(`  ${status}: ${item}`)
  }
} finally {
  if (server.listening) await new Promise(resolve => server.close(resolve))
  await rm(workspace, { recursive: true, force: true })
}
