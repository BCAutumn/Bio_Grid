import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { extname, join, normalize } from 'node:path';

const port = Number(process.env.PORT || 5173);
const host = process.env.HOST || '127.0.0.1';
const root = process.cwd();
const backendHost = process.env.BACKEND_HOST || '127.0.0.1';
const backendPort = Number(process.env.BACKEND_PORT || 8787);

const mime = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8'
};
const securityHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin'
};

function toSafePath(urlPath) {
  const clean = normalize(urlPath).replace(/^\/+/, '');
  if (clean.includes('..')) return null;
  return join(root, clean || 'index.html');
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);

  // Proxy API calls to python backend (same-origin for browser).
  if (url.pathname === '/health' || url.pathname.startsWith('/api/')) {
    const method = String(req.method || 'GET').toUpperCase();
    const wantsBody = method === 'POST' || method === 'PUT' || method === 'PATCH';

    const forward = (bodyBuf) => {
      const headersIn = { ...req.headers };
      // Ensure backend can read body deterministically (avoid chunked -> missing content-length).
      if (bodyBuf !== null) {
        headersIn['content-length'] = String(bodyBuf.length);
        delete headersIn['transfer-encoding'];
      }
      const proxy = httpRequest(
        {
          protocol: 'http:',
          host: backendHost,
          port: backendPort,
          method,
          path: url.pathname + url.search,
          headers: {
            ...headersIn,
            host: `${backendHost}:${backendPort}`
          }
        },
        (proxyRes) => {
          const headers = { ...proxyRes.headers, ...securityHeaders };
          res.writeHead(proxyRes.statusCode || 502, headers);
          proxyRes.pipe(res);
        }
      );
      proxy.on('error', (error) => {
        res.writeHead(502, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'backend_unreachable', message: error.message }));
      });
      if (bodyBuf !== null) proxy.end(bodyBuf);
      else req.pipe(proxy);
    };

    if (!wantsBody) {
      forward(null);
      return;
    }

    // Buffer request body so we can set Content-Length reliably.
    const bodyBuf = await new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      req.on('data', (c) => {
        chunks.push(c);
        total += c.length;
        if (total > 10 * 1024 * 1024) req.destroy(new Error('Proxy body too large'));
      });
      req.on('end', () => resolve(Buffer.concat(chunks, total)));
      req.on('aborted', () => reject(new Error('Client aborted request')));
      req.on('error', reject);
    }).catch((error) => {
      res.writeHead(400, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'bad_request', message: error.message }));
      return null;
    });
    if (bodyBuf === null) return;
    forward(bodyBuf);
    return;
  }

  const localPath = toSafePath(url.pathname === '/' ? '/index.html' : url.pathname);
  if (!localPath) {
    res.writeHead(400, { ...securityHeaders, 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad request');
    return;
  }

  try {
    const stat = await fs.stat(localPath);
    if (stat.isDirectory()) {
      res.writeHead(403, { ...securityHeaders, 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Directory listing disabled');
      return;
    }
    const contentType = mime[extname(localPath)] || 'application/octet-stream';
    res.writeHead(200, { ...securityHeaders, 'Content-Type': contentType, 'Cache-Control': 'no-store' });
    createReadStream(localPath).pipe(res);
  } catch {
    res.writeHead(404, { ...securityHeaders, 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
});

server.on('error', (error) => {
  console.error(`Server failed: ${error.code || error.message}`);
  process.exitCode = 1;
});

server.listen(port, host, () => {
  console.log(`Bio-Grid dev server running at http://${host}:${port}`);
});
