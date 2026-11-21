import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const banner = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="42"><rect width="120" height="42" fill="#184f55"/></svg>',
)

function layout(title, ...content) {
  return '<!doctype html>' + renderToStaticMarkup(
    h('html', { lang: 'en' },
      h('head', null,
        h('meta', { charSet: 'utf-8' }),
        h('title', null, title),
        h('style', null, 'body { font: 1rem system-ui; margin: 2rem; } a { display: inline-block; line-height: 2rem; }'),
      ),
      h('body', null, h('main', null, h('h1', null, title), ...content)),
    ),
  )
}

function home(revised) {
  return layout('Community workshop',
    h('p', null, 'A hands-on afternoon for people learning to repair everyday items.'),
    h('img', { id: 'workshop-banner', src: banner, width: 120, height: 42,
      ...(revised ? { alt: '' } : {}) }),
    h('ul', null,
      h('li', null, h('a', { href: '/schedule' }, 'Workshop schedule')),
      h('li', null, h('a', { href: '/workshop-recording' }, 'Watch the last workshop')),
      revised && h('li', null, h('a', { href: '/partner-guide' }, 'Read the partner guide')),
    ),
  )
}

export function createDemoServer(isRevised) {
  return createServer((request, response) => {
    if (request.url === '/api/health') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ status: 'ok' }))
      return
    }

    const schedule = request.url === '/schedule'
    const status = request.url === '/' || schedule ? 200 : 404
    const document = request.url === '/' ? home(isRevised()) : layout(
      schedule ? 'Workshop schedule' : 'Page not found',
      h('p', null, schedule ? 'Doors open at 1 pm.' : 'This resource is unavailable.'),
    )
    response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
    response.end(document)
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const scenario = process.argv[2] ?? 'before'
  if (!['before', 'after'].includes(scenario)) throw new Error('Choose before or after.')
  createDemoServer(() => scenario === 'after').listen(4173, '127.0.0.1', () => {
    console.log(`Community workshop (${scenario}) at http://127.0.0.1:4173`)
  })
}
