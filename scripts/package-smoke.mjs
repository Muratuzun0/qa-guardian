import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const temporary = await mkdtemp(join(tmpdir(), 'qa-guardian-package-'));
const requestedPaths = [];
const server = createServer((request, response) => {
  requestedPaths.push(request.url);
  if (request.url === '/api/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{"ready":true}');
    return;
  }

  const status = request.url === '/' ? 200 : 404;
  response.writeHead(status, { 'Content-Type': 'text/html' });
  response.end('<!doctype html><html lang="en"><title>Package fixture</title></html>');
});

function npm(args, cwd) {
  const options = { cwd, timeout: 120_000 };
  const npmCli = process.env.npm_execpath ?? (process.platform === 'win32'
    ? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : undefined);
  return npmCli
    ? exec(process.execPath, [npmCli, ...args], options)
    : exec('npm', args, options);
}

try {
  const { stdout: packed } = await npm(['pack', '--json', '--pack-destination', temporary], root);
  const [archive] = JSON.parse(packed);
  assert.equal(archive.name, manifest.name);
  assert.equal(archive.version, manifest.version);
  const tarball = await readFile(join(temporary, archive.filename));
  const digest = createHash('sha512').update(tarball).digest('base64');
  assert.equal(archive.integrity, `sha512-${digest}`);

  const files = archive.files.map(({ path }) => path);
  const required = ['package.json', 'README.md', 'LICENSE', 'dist/cli.js'];
  for (const path of required) {
    assert.ok(files.includes(path), `Missing from package: ${path}`);
  }
  const unexpected = files.filter((path) =>
    !required.includes(path) && !/^dist\/(?:[\w-]+\/)*[\w-]+\.(?:js|js\.map|d\.ts|d\.ts\.map)$/.test(path));
  assert.deepEqual(unexpected, [], 'Unexpected contents in published package');

  await writeFile(join(temporary, 'package.json'), '{"private":true}\n');
  await npm([
    'install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock',
    '--prefer-offline', `./${archive.filename}`,
  ], temporary);
  const { stdout: playwrightVersion } = await npm(['exec', '--no', '--offline', '--', 'playwright', '--version'], temporary);
  assert.equal(playwrightVersion.trim(), `Version ${manifest.dependencies.playwright}`);

  const invoke = process.platform === 'win32'
    ? (...args) => npm(['exec', '--no', '--offline', '--', 'qa-guardian', ...args], temporary)
    : (...args) => exec(join(temporary, 'node_modules', '.bin', 'qa-guardian'), args, {
      cwd: temporary,
      timeout: 15_000,
    });

  assert.match((await invoke('--help')).stdout, /qa-guardian/i);
  assert.equal((await invoke('--version')).stdout.trim(), manifest.version);
  await invoke('init');

  const configPath = join(temporary, 'qa-guardian.config.json');
  assert.equal(typeof JSON.parse(await readFile(configPath, 'utf8')).baseUrl, 'string');

  await once(server.listen(0, '127.0.0.1'), 'listening');
  await writeFile(configPath, JSON.stringify({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    routes: ['/'],
    checks: { pages: true, links: false, accessibility: false, api: true },
    api: [{ path: '/api/health', assertions: [{ path: ['ready'], equals: true }] }],
  }));

  const { stdout } = await invoke('check', '--json');
  const report = JSON.parse(stdout);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.exitCode, 0);
  assert.deepEqual(report.results.filter(({ status }) => status === 'pass').map(({ check }) => check).sort(),
    ['api', 'pages']);
  assert.deepEqual(new Set(requestedPaths), new Set(['/', '/api/health']));
  console.log(`Packed and installed ${archive.name}@${archive.version}; verified CLI and local checks.`);
} finally {
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
