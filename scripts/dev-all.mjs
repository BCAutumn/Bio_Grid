import { spawn } from 'node:child_process';

function run(cmd, args, options = {}) {
  const child = spawn(cmd, args, { stdio: 'inherit', shell: false, ...options });
  child.on('exit', (code) => {
    if (code && code !== 0) process.exitCode = code;
  });
  return child;
}

const backendPort = Number(process.env.BACKEND_PORT || 8787);

// Frontend static server (COOP/COEP headers included for SharedArrayBuffer).
run(process.execPath, ['scripts/dev-server.mjs']);

// Minimal backend placeholder (can be extended to Taichi/WS later).
run('python3', ['-m', 'biogrid.dev_backend', '--port', String(backendPort)], {
  cwd: 'py',
  env: { ...process.env, PYTHONUNBUFFERED: '1' }
});

