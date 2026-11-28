import { once } from 'node:events';
import { createServer } from 'node:http';

function html(response, content, title = 'QA Guardian fixture') {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>${content}</body></html>`);
}

export async function startFixture() {
  const requests = [];
  const statusOverrides = new Map();
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    requests.push({ path, method: request.method, authorization: request.headers.authorization });

    const status = statusOverrides.get(path);
    if (status !== undefined) {
      response.writeHead(status).end();
      return;
    }

    switch (path) {
      case '/':
      case '/healthy':
        html(response, '<main><h1>Home</h1><a href="/healthy#details">Details</a><h2 id="details">Details</h2></main>');
        break;
      case '/rendered':
      case '/rendered-baseline':
        html(response, `
          <main><h1>Rendered page</h1><img src="/pixel.svg">
          <p id="present">A valid fragment</p>
          <a href="#present">Valid fragment</a>
          <a href="#absent">Missing fragment</a>
          <a href="/healthy#details">Valid fragment on a different page</a>
          <a href="/redirect#details">Valid fragment through a redirect</a>
          <a href="mailto:team@example.invalid">Email</a>
          <a href="http://example.invalid/do-not-request">Out-of-scope URL</a></main>
          <script>
            const link = document.createElement('a');
            link.href = '/missing';
            link.textContent = 'Rendered broken link';
            document.querySelector('main').append(link);
          </script>`);
        break;
      case '/encoded-fragments':
        html(response, `
          <main><h1>Encoded fragments</h1>
          <h2 id="caf\u00e9">Caf\u00e9</h2>
          <a href="#caf%C3%A9">Valid percent-encoded fragment</a>
          <a href="#bad%zz">Invalid percent escape</a></main>`);
        break;
      case '/pixel.svg':
        response.writeHead(200, { 'content-type': 'image/svg+xml' });
        response.end('<svg xmlns="http://www.w3.org/2000/svg" width="5" height="5"><rect width="5" height="5"/></svg>');
        break;
      case '/redirect':
        response.writeHead(302, { location: '/healthy' }).end();
        break;
      case '/loop':
        response.writeHead(302, { location: '/loop' }).end();
        break;
      case '/slow': {
        const timer = setTimeout(() => html(response, '<main><h1>Slow page</h1></main>'), 2_000);
        response.on('close', () => clearTimeout(timer));
        break;
      }
      case '/api/health':
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ health: { ready: true }, users: [{ active: true }] }));
        break;
      case '/api/invalid-json':
        response.writeHead(200, { 'content-type': 'application/json' }).end('{');
        break;
      case '/api/mutation':
        response.writeHead(204).end();
        break;
      default:
        response.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  return {
    requests,
    setStatus(path, status) {
      statusOverrides.set(path, status);
    },
    origin: `http://127.0.0.1:${server.address().port}`,
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    },
  };
}
