import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startFixture } from './fixtures/web.mjs';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const configFile = 'qa-guardian.config.json';
const reportFile = 'qa-guardian-report.json';
const pageChecks = { pages: true, links: false, accessibility: false, api: false };
const apiChecks = { ...pageChecks, pages: false, api: true };
let fixture;

before(async () => {
  fixture = await startFixture();
});
after(async () => {
  await fixture?.close();
});

async function workspace(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'qa-guardian-cli-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

async function config(cwd, options, filename = configFile) {
  await writeFile(join(cwd, filename), JSON.stringify({ baseUrl: fixture.origin, ...options }));
}

function run(cwd, args, env = {}, timeout = 45_000) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [cli, ...args], {
      cwd,
      env: { ...process.env, ...env },
      timeout,
    }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') {
        reject(error);
        return;
      }
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });
}

function parse(result, code) {
  assert.equal(result.code, code, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.exitCode, code);
  for (const entry of report.results) {
    assert.ok(['pages', 'links', 'accessibility', 'api', 'execution'].includes(entry.check), entry.check);
    assert.ok(Number.isFinite(entry.durationMs) && entry.durationMs >= 0);
    assert.ok(entry.message);
  }
  return report;
}

function hasResult(report, check, status, route) {
  return report.results.some((result) => result.check === check && result.status === status &&
    (route === undefined || (result.url && new URL(result.url).pathname === route)));
}

test('prints help and version and rejects an unknown CLI option', async (t) => {
  const cwd = await workspace(t);
  const help = await run(cwd, ['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /check/);
  assert.match(help.stdout, /init/);

  const version = await run(cwd, ['--version']);
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(version.code, 0);
  assert.equal(version.stdout.trim(), manifest.version);

  const invalid = parse(await run(cwd, ['check', '--not-a-real-option', '--json']), 2);
  assert.match(invalid.results[0].message, /(?:invalid|unknown).*(?:argument|option)/i);
});

test('init writes a valid configuration and preserves an existing file', async (t) => {
  const cwd = await workspace(t);
  assert.equal((await run(cwd, ['init'])).code, 0);
  const generated = await readFile(join(cwd, configFile), 'utf8');
  assert.ok(JSON.parse(generated).baseUrl);

  const second = await run(cwd, ['init']);
  assert.equal(second.code, 2);
  assert.equal(await readFile(join(cwd, configFile), 'utf8'), generated);
});

test('loads a custom configuration, overrides its URL and writes the JSON report', async (t) => {
  const cwd = await workspace(t);
  await config(cwd, {
    baseUrl: 'http://localhost:1',
    checks: pageChecks,
    routes: ['/healthy', '/redirect'],
    reportDir: 'reports',
  }, 'custom.json');
  const result = await run(cwd, ['check', '--config', 'custom.json', '--url', fixture.origin, '--json']);
  const report = parse(result, 0);
  assert.ok(hasResult(report, 'pages', 'pass', '/healthy'));
  assert.ok(hasResult(report, 'pages', 'pass', '/redirect'));
  assert.deepEqual(JSON.parse(await readFile(join(cwd, 'reports', reportFile), 'utf8')), report);

  const terminal = await run(cwd, ['check', '--config', 'custom.json', '--url', fixture.origin]);
  assert.equal(terminal.code, 0);
  assert.match(terminal.stdout, /healthy/);
});

test('reports missing pages, redirect loops and timeouts as failed checks', async (t) => {
  const cwd = await workspace(t);
  await config(cwd, {
    checks: pageChecks,
    routes: ['/missing', '/loop', '/slow'],
    timeoutMs: 150,
  });
  const report = parse(await run(cwd, ['check', '--json']), 1);
  for (const route of ['/missing', '/loop', '/slow']) {
    assert.ok(hasResult(report, 'pages', 'fail', route), route);
  }
  assert.match(report.results.find((result) => result.url.endsWith('/slow')).message, /tim(e|ed).{0,2}out/i);
});

test('reports a refused socket as a check failure', async (t) => {
  const cwd = await workspace(t);
  const closed = await startFixture();
  await closed.close();
  await config(cwd, { baseUrl: closed.origin, checks: pageChecks });
  const report = parse(await run(cwd, ['check', '--json']), 1);
  assert.ok(hasResult(report, 'pages', 'fail', '/'));
});

test('detects structured API assertion, JSON and HTTP failures without exposing secrets', async (t) => {
  const cwd = await workspace(t);
  const secret = 'fixture-secret-for-redaction';
  await config(cwd, {
    checks: apiChecks,
    api: [
      { path: '/slow', timeoutMs: 150 },
      { path: '/redirect', expectedStatus: 302 },
      {
        path: '/api/health',
        headers: { Authorization: '${QA_GUARDIAN_TEST_TOKEN}' },
        assertions: [
          { path: ['health', 'ready'], equals: true },
          { path: ['users', '0', 'active'], equals: true },
        ],
      },
      { path: '/api/health', assertions: [{ path: ['health', 'ready'], equals: secret }] },
      { path: '/api/invalid-json', assertions: [{ path: ['health'], equals: true }] },
      { path: '/missing?token=' + secret },
    ],
  });
  const result = await run(cwd, ['check', '--json'], { QA_GUARDIAN_TEST_TOKEN: secret });
  const report = parse(result, 1);
  assert.ok(hasResult(report, 'api', 'pass', '/api/health'));
  assert.ok(hasResult(report, 'api', 'pass', '/redirect'));
  assert.ok(hasResult(report, 'api', 'fail', '/api/health'));
  assert.ok(hasResult(report, 'api', 'fail', '/api/invalid-json'));
  assert.ok(hasResult(report, 'api', 'fail', '/missing'));
  assert.match(report.results.find((result) => result.url.endsWith('/slow')).message, /tim(e|ed).{0,2}out/i);
  assert.ok(fixture.requests.some((request) => request.path === '/api/health' && request.authorization === secret));
  assert.doesNotMatch(result.stderr + result.stdout, new RegExp(secret));
});

test('requires explicit authorization for mutating API methods', async (t) => {
  const cwd = await workspace(t);
  const options = {
    checks: apiChecks,
    api: [{ path: '/api/mutation', method: 'POST', expectedStatus: 204 }],
  };
  await config(cwd, options);
  const blocked = await run(cwd, ['check', '--json']);
  assert.equal(blocked.code, 2);
  assert.ok(!fixture.requests.some((request) => request.path === '/api/mutation'));

  await config(cwd, { ...options, allowUnsafeMethods: true });
  const report = parse(await run(cwd, ['check', '--json']), 0);
  assert.ok(hasResult(report, 'api', 'pass', '/api/mutation'));
  assert.ok(fixture.requests.some((request) => request.path === '/api/mutation' && request.method === 'POST'));
});

test('malformed configuration and an unwritable report directory use the execution error exit code', async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, configFile), '{');
  const malformed = parse(await run(cwd, ['check', '--json']), 2);
  assert.match(malformed.results[0].message, /config|JSON/i);

  await writeFile(join(cwd, 'reports'), 'a file blocks creation of this directory');
  await config(cwd, { checks: pageChecks, reportDir: 'reports' });
  const blocked = parse(await run(cwd, ['check', '--json']), 2);
  assert.match(blocked.results.find((entry) => entry.status === 'error')?.message, /report/i);
});

test('rejects a FIFO configuration without waiting for a writer', {
  skip: process.platform !== 'linux',
}, async (t) => {
  const cwd = await workspace(t);
  execFileSync('mkfifo', [join(cwd, configFile)]);

  const report = parse(await run(cwd, ['check', '--json'], {}, 5_000), 2);
  assert.match(report.results.find((entry) => entry.status === 'error')?.message, /regular file/i);
});

test('refuses a report path that traverses a symbolic link', async (t) => {
  const cwd = await workspace(t);
  const destination = await workspace(t);
  await symlink(destination, join(cwd, 'reports'), process.platform === 'win32' ? 'junction' : 'dir');
  await config(cwd, { checks: pageChecks, reportDir: 'reports' });

  const report = parse(await run(cwd, ['check', '--json']), 2);
  assert.match(report.results.find((entry) => entry.status === 'error')?.message, /report/i);
  await assert.rejects(readFile(join(destination, reportFile)), { code: 'ENOENT' });
});

test('checks rendered links, fragments and accessibility on a local page', async (t) => {
  const cwd = await workspace(t);
  await config(cwd, {
    checks: { ...pageChecks, links: true, accessibility: true },
    routes: ['/rendered'],
  });

  const report = parse(await run(cwd, ['check', '--json']), 1);
  assert.ok(hasResult(report, 'pages', 'pass', '/rendered'));
  assert.ok(hasResult(report, 'links', 'fail', '/missing'));
  assert.ok(hasResult(report, 'links', 'fail', '/rendered'));
  assert.ok(hasResult(report, 'links', 'pass', '/healthy'));
  assert.ok(!hasResult(report, 'links', 'fail', '/redirect'));
  assert.ok(!hasResult(report, 'links', 'fail', '/do-not-request'));
  const accessibility = report.results.find((result) =>
    result.check === 'accessibility' && result.rule === 'image-alt');
  assert.equal(accessibility?.status, 'fail');
  assert.match(accessibility.targets.join(' '), /img/i);
  assert.match(accessibility.guidance, /^https:\/\//);
});

test('checks an initial URL without creating a configuration file', async (t) => {
  const cwd = await workspace(t);
  const report = parse(await run(cwd, ['check', '--url', fixture.origin, '--json']), 0);
  assert.ok(hasResult(report, 'pages', 'pass', '/'));
  assert.ok(hasResult(report, 'links', 'pass', '/healthy'));
  assert.ok(hasResult(report, 'accessibility', 'pass', '/'));
});

test('provides installation guidance when Chromium is missing', async (t) => {
  const cwd = await workspace(t);
  const env = {
    PLAYWRIGHT_BROWSERS_PATH: join(cwd, 'empty-browser-cache'),
    QA_GUARDIAN_CHROMIUM_PATH: '',
  };
  const result = await run(cwd, ['check', '--url', fixture.origin, '--json'], env);
  assert.equal(result.code, 2);
  assert.match(result.stdout + result.stderr, /playwright install(?:-deps)? chromium/i);

  await config(cwd, { checks: pageChecks });
  assert.ok(hasResult(parse(await run(cwd, ['check', '--json'], env), 0), 'pages', 'pass', '/'));
});

test('only fails warning-level findings when configured to fail on warnings', async (t) => {
  const cwd = await workspace(t);
  const options = {
    checks: { ...pageChecks, links: true },
    routes: ['/rendered'],
    links: { maxLinksPerPage: 1 },
  };
  await config(cwd, options);
  const defaultReport = parse(await run(cwd, ['check', '--json']), 0);
  assert.ok(defaultReport.results.some((result) =>
    result.check === 'links' && result.status === 'fail' && result.severity === 'warning'));

  await config(cwd, { ...options, failOn: 'warning' });
  parse(await run(cwd, ['check', '--json']), 1);
});

test('saves findings and distinguishes new, unchanged and resolved findings', async (t) => {
  const cwd = await workspace(t);
  const baselinePath = join(cwd, '.qa-guardian-baseline.json');
  const routes = ['/baseline-unchanged', '/baseline-resolved', '/baseline-new'];
  await config(cwd, { checks: pageChecks, routes });
  fixture.setStatus('/baseline-unchanged', 404);
  fixture.setStatus('/baseline-resolved', 404);
  fixture.setStatus('/baseline-new', 200);

  const saved = parse(await run(cwd, ['check', '--save-baseline', '--json']), 1);
  assert.ok(hasResult(saved, 'pages', 'fail', '/baseline-unchanged'));
  const baseline = await readFile(baselinePath, 'utf8');
  assert.doesNotThrow(() => JSON.parse(baseline));

  const unchanged = parse(await run(cwd, ['check', '--baseline', '--json']), 0);
  assert.deepEqual(unchanged.regression.new, []);
  assert.equal(unchanged.regression.unchanged.length, 2);
  assert.deepEqual(unchanged.regression.resolved, []);

  fixture.setStatus('/baseline-resolved', 200);
  fixture.setStatus('/baseline-new', 404);
  const changed = parse(await run(cwd, ['check', '--baseline', '--json']), 1);
  assert.equal(changed.regression.new.length, 1);
  assert.equal(changed.regression.unchanged.length, 1);
  assert.equal(changed.regression.resolved.length, 1);
  assert.equal(new URL(changed.regression.new[0].url).pathname, '/baseline-new');
  assert.equal(new URL(changed.regression.unchanged[0].url).pathname, '/baseline-unchanged');
  assert.equal(new URL(changed.regression.resolved[0].url).pathname, '/baseline-resolved');
  assert.ok(changed.regression.new[0].fingerprint);

  parse(await run(cwd, ['check', '--save-baseline', '--json']), 2);
  assert.equal(await readFile(baselinePath, 'utf8'), baseline);

  await config(cwd, { checks: pageChecks, routes: routes.slice(1) });
  const incompatible = parse(await run(cwd, ['check', '--baseline', '--json']), 2);
  assert.match(incompatible.results.find((entry) => entry.status === 'error')?.message, /baseline/i);
});

test('rejects missing or malformed baselines and mutually exclusive options', async (t) => {
  const cwd = await workspace(t);
  await config(cwd, { checks: pageChecks });

  const missing = parse(await run(cwd, ['check', '--baseline', '--json']), 2);
  assert.match(missing.results.find((entry) => entry.status === 'error')?.message, /baseline/i);

  await writeFile(join(cwd, '.qa-guardian-baseline.json'), '{');
  const malformed = parse(await run(cwd, ['check', '--baseline', '--json']), 2);
  assert.match(malformed.results.find((entry) => entry.status === 'error')?.message, /baseline/i);

  const conflict = parse(await run(cwd, ['check', '--save-baseline', '--baseline', '--json']), 2);
  assert.match(conflict.results.find((entry) => entry.status === 'error')?.message, /baseline/i);
});

test('marks old browser findings unverified when the page becomes unavailable', async (t) => {
  const cwd = await workspace(t);
  const route = '/rendered-baseline';
  await config(cwd, { checks: { ...pageChecks, links: true, accessibility: true }, routes: [route] });

  const saved = parse(await run(cwd, ['check', '--save-baseline', '--json']), 1);
  assert.ok(hasResult(saved, 'accessibility', 'fail', route));
  assert.ok(hasResult(saved, 'links', 'fail', '/missing'));

  fixture.setStatus(route, 503);
  const report = parse(await run(cwd, ['check', '--baseline', '--json']), 1);
  assert.deepEqual(report.regression.resolved, []);
  assert.ok(report.regression.new.some((entry) => entry.check === 'pages'));
  assert.ok(report.regression.unverified.some((entry) => entry.check === 'accessibility'));
  assert.ok(report.regression.unverified.some((entry) => entry.check === 'links'));
});
