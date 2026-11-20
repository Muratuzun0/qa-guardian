import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { after, before, test } from 'node:test'
import { parseTarget, request, RequestError, safeUrl } from '../dist/network.js'

let server
let base
let received

before(async () => {
  received = []
  server = createServer((req, res) => {
    received.push({ url: req.url, method: req.method, authorization: req.headers.authorization })
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/healthy#somewhere' }).end()
      return
    }
    if (req.url === '/cross-origin') {
      res.writeHead(302, { location: 'http://localhost:' + server.address().port + '/healthy' }).end()
      return
    }
    if (req.url === '/loop') {
      res.writeHead(302, { location: '/loop' }).end()
      return
    }
    if (req.url === '/no-location') {
      res.writeHead(302).end()
      return
    }
    if (req.url === '/invalid-location') {
      res.writeHead(302, { location: 'http://name:secret@sample.test/' }).end()
      return
    }
    if (req.url === '/slow') {
      res.writeHead(200)
      res.write('part')
      const timer = setTimeout(() => res.end('two'), 3000)
      res.once('close', () => clearTimeout(timer))
      return
    }
    if (req.url === '/disconnect') {
      res.writeHead(200)
      res.write('part', () => req.socket.destroy())
      return
    }
    if (req.url === '/binary') {
      res.end(Buffer.from([0xff, 0x00, 0x80, 0x01]))
      return
    }
    res.end('healthy')
  })
  await once(server.listen(0, '127.0.0.1'), 'listening')
  base = new URL('http://127.0.0.1:' + server.address().port)
})

after(async () => {
  if (server?.listening) {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

function fetchRoute(path, options = {}) {
  return request(parseTarget(path, base), { base, timeoutMs: 1500, ...options })
}

function isRequestError(code) {
  return error => error instanceof RequestError && error.code === code
}

test('normalizes relative and unusual IP URLs and redacts query and fragment', () => {
  const url = parseTarget('../status?a=secret#main', new URL('https://sample.test/dev/app'))
  assert.equal(url.href, 'https://sample.test/status?a=secret#main')
  assert.equal(safeUrl(url), 'https://sample.test/status')
  assert.equal(parseTarget('http://0x7f000001').hostname, '127.0.0.1')
})

test('rejects malformed URLs, credentials, browser protocols, and control characters', () => {
  for (const invalid of ['http://[broken', 'http://user:secret@sample.test', 'file:///tmp/x', 'http://a\tb']) {
    assert.throws(() => parseTarget(invalid), error => isRequestError('invalid-url')(error)
      && !error.message.includes('secret'))
  }
})

test('follows only bounded redirects and keeps same-origin authorization', async () => {
  const result = await fetchRoute('/redirect', { headers: { authorization: 'Bearer fixture' }, readBody: true })
  assert.equal(result.status, 200)
  assert.equal(result.body, 'healthy')
  assert.equal(result.url.pathname, '/healthy')
  assert.equal(result.url.hash, '')
  assert.equal(received.at(-1).authorization, 'Bearer fixture')
  const start = received.length
  await assert.rejects(fetchRoute('/loop'), isRequestError('redirect'))
  assert.equal(received.length - start, 6)
  await assert.rejects(fetchRoute('/no-location'), isRequestError('redirect'))
  await assert.rejects(fetchRoute('/invalid-location'), error => isRequestError('redirect')(error)
    && !error.message.includes('secret'))
})

test('supports manual redirects for callers that control each hop', async () => {
  const result = await fetchRoute('/redirect', { followRedirects: false })
  assert.equal(result.status, 302)
  assert.equal(result.headers.location, '/healthy#somewhere')
})

test('blocks unlisted targets, external private literals, and external private DNS', async () => {
  const start = received.length
  await assert.rejects(fetchRoute('/cross-origin'), isRequestError('blocked-target'))
  assert.equal(received.length - start, 1)
  for (const origin of [
    'http://0x7f000001:9',
    'http://[::ffff:127.0.0.1]:9',
    'http://[::1]:9',
    'http://169.254.169.254:9',
    'http://100.64.0.1:9',
    'http://localhost:9',
  ]) {
    const target = parseTarget(origin)
    await assert.rejects(request(target, { base, timeoutMs: 1500, externalOrigins: [target.origin] }),
      isRequestError('blocked-target'))
  }
})

test('does not follow redirects for methods that may modify data', async () => {
  const start = received.length
  await assert.rejects(fetchRoute('/redirect', { method: 'POST' }), isRequestError('redirect'))
  assert.deepEqual(received.slice(start).map(({ method, url }) => ({ method, url })), [
    { method: 'POST', url: '/redirect' },
  ])
})

test('bounds the body size and preserves raw bytes in binary mode', async () => {
  await assert.rejects(fetchRoute('/binary', { readBody: true, maxBodyBytes: 3 }), isRequestError('body-limit'))
  const result = await fetchRoute('/binary', { readBody: true, maxBodyBytes: 4, binary: true })
  assert.deepEqual(result.bytes, Buffer.from([0xff, 0x00, 0x80, 0x01]))
})

test('applies timeouts to body reads and can finish on headers for status-only checks', async () => {
  const statusOnly = await fetchRoute('/slow', { timeoutMs: 1000 })
  assert.equal(statusOnly.status, 200)
  assert.equal(statusOnly.body, '')
  await assert.rejects(fetchRoute('/slow', { timeoutMs: 100, readBody: true }), isRequestError('timeout'))
  await assert.rejects(fetchRoute('/disconnect', { readBody: true }), isRequestError('network'))
})

test('classifies caller cancellation and rejects reserved headers without logging values', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(fetchRoute('/healthy', { signal: controller.signal }), isRequestError('cancelled'))
  await assert.rejects(fetchRoute('/healthy', { headers: { Host: 'secret.invalid' } }),
    error => isRequestError('invalid-request')(error) && !error.message.includes('secret'))
})
