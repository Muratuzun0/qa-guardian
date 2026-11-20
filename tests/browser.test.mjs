import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { BrowserError, openBrowser } from '../dist/browser.js';

let browser;
let base;
let other;
let primary;
let otherHits = 0;
const received = [];

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return new URL('http://127.0.0.1:' + server.address().port);
}

before(async () => {
  other = createServer((_request, response) => {
    otherHits += 1;
    response.end('Unexpected external request');
  });
  other.on('upgrade', (_request, socket) => {
    otherHits += 1;
    socket.destroy();
  });
  const outside = await listen(other);
  const websocket = outside.href.replace('http:', 'ws:');

  primary = createServer((request, response) => {
    received.push([request.method, request.url]);
    if (request.url === '/redirect-asset') {
      response.writeHead(302, { location: outside.href }).end();
      return;
    }
    if (request.url?.startsWith('/slow-page?')) return;
    if (request.url === '/render.js') {
      response.writeHead(200, { 'content-type': 'text/javascript' }).end(`
        const a = document.createElement('a');
        a.href = 'linked#fragment';
        a.textContent = 'Rendered link';
        document.querySelector('main').append(a, a.cloneNode(true));
        fetch('/mutating-operation', { method: 'POST' }).catch(() => {});
        new WebSocket('${websocket}');
      `);
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`
      <!doctype html>
      <html lang="en">
        <head><title>Browser fixture</title><base href="/docs/"></head>
        <body>
          <main id="main">
            <h1>Browser fixture</h1>
            <button></button>
            <a name="legacy-fragment">Older fragment</a>
            <a href="mailto:example@example.com">Email</a>
            <a href="http://[invalid">Invalid link</a>
            <a href="another">Another link</a>
            <img src="${outside.href}" alt="">
            <img src="/redirect-asset" alt="">
            <script src="/render.js"></script>
          </main>
        </body>
      </html>
    `);
  });

  base = await listen(primary);
  browser = await openBrowser({ headless: true, timeoutMs: 10000 });
});

after(async () => {
  await browser?.close();
  await Promise.all([primary, other].filter(Boolean).map(server => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  })));
});

test('extracts rendered DOM links and axe violations within network restrictions', async () => {
  const result = await browser.inspect(base, {
    base, accessibility: true, links: true, maxLinks: 10, timeoutMs: 5000,
  });
  assert.deepEqual(result.links.map(link => link.href), [
    'http://[invalid',
    new URL('/docs/another', base).href,
    new URL('/docs/linked#fragment', base).href,
  ]);
  assert.deepEqual(result.anchors, ['main', 'legacy-fragment']);
  assert.equal(result.truncated, false);

  const buttonName = result.violations.find(rule => rule.id === 'button-name');
  assert.ok(buttonName);
  assert.ok(buttonName.description);
  assert.match(buttonName.helpUrl, /^https:/);
  assert.ok(buttonName.targets.some(target => target.includes('button')));
  assert.ok(received.some(entry => entry[1] === '/redirect-asset'));
  assert.ok(received.some(entry => entry[1] === '/render.js'));
  assert.ok(!received.some(entry => entry[0] === 'POST'));
  assert.equal(otherHits, 0);
});

test('reports link truncation and skips axe when disabled', async () => {
  const result = await browser.inspect(base, {
    base, accessibility: false, links: true, maxLinks: 1, timeoutMs: 5000,
  });
  assert.equal(result.links.length, 1);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.violations, []);
});

test('classifies a browser inspection timeout without exposing the route query', async () => {
  await assert.rejects(browser.inspect(new URL('/slow-page?secret=fixture', base), {
    base, accessibility: false, links: true, maxLinks: 1, timeoutMs: 250,
  }), error => error instanceof BrowserError && error.code === 'timeout'
    && !error.message.includes('fixture'));
});
