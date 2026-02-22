import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const port = Number(process.env.PORT || 5173);
const host = process.env.HOST || '127.0.0.1';
const root = process.cwd();

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
