import { createServer } from 'node:http'

createServer((req, res) => {
  const headers = { 'content-type': 'application/json', 'x-content-type-options': 'nosniff' }
  if (req.url === '/api/account') {
    const member = req.headers.authorization === 'Bearer demo-member'
    res.writeHead(member ? 200 : 401, { ...headers, 'cache-control': 'no-store' })
    res.end(JSON.stringify(member ? { plan: 'test' } : { message: 'Sign in required' }))
    return
  }
  if (req.url === '/api/debug') {
    res.writeHead(200, { ...headers, 'access-control-allow-origin': '*', 'access-control-allow-credentials': 'true' })
    res.end(JSON.stringify({ internal: { debugValue: 'synthetic-demo-only' }, error: 'SQLSTATE[HY000] synthetic diagnostic' }))
    return
  }
  res.writeHead(404, headers).end('{}')
}).listen(4185, '127.0.0.1', () => console.log('API security fixture at http://127.0.0.1:4185'))
