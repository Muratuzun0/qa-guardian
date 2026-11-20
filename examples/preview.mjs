import { createServer } from 'node:http'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: { 'broken-link': { type: 'boolean' } } })
const extraLink = values['broken-link'] ? '<p><a href="/missing">Unpublished page</a></p>' : ''

const pages = new Map([
  ['/', ['QA Guardian example', `<h1>Example site</h1><p><a href="/about#project">About the project</a></p>${extraLink}`]],
  ['/about', ['About the example', '<h1 id="project">About the project</h1><p><a href="/">Home</a></p>']],
]);

const server = createServer((request, response) => {
  if (request.url === '/api/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  const page = pages.get(request.url);
  if (!page) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Page not found');
    return;
  }

  const [title, content] = page;
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><main>${content}</main></body></html>`);
});

server.listen(3000, '127.0.0.1', () => {
  console.log('QA Guardian example listening on http://127.0.0.1:3000');
});
