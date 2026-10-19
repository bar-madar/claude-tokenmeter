'use strict';

// Local dashboard server. Serves the page and the stats JSON on 127.0.0.1
// only, so nothing is reachable from other machines.
//
//   node dashboard/server.js [--open]
//
// Environment:
//   TOKENMETER_PORT     port to listen on (default 4545)
//   CLAUDE_CONFIG_DIR   Claude Code's config folder (default ~/.claude)

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { CONFIG_DIR, PROJECTS_DIR, scan, summarize } = require('../scanner');

const PORT = Number(process.env.TOKENMETER_PORT) || 4545;
const PUBLIC_DIR = path.join(__dirname, 'public');
// Written by the in-session pane: plan limits and context fill, which the logs don't carry.
const LIVE_FILE = path.join(CONFIG_DIR, 'tokenmeter-live.json');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function readLive() {
  try {
    return JSON.parse(fs.readFileSync(LIVE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function sendJson(res, body) {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/stats') {
    const r = scan();
    return sendJson(res, { ...r, sessions: r.sessions.slice(0, 300), live: readLive() });
  }
  if (url.pathname === '/api/summary') {
    return sendJson(res, summarize(scan(), url.searchParams.get('session')));
  }
  // Static files: a flat folder, so the base name is all a request can name.
  const file = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : path.basename(url.pathname));
  if (!fs.existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('Not found');
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '', url]]
    : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

function start({ open = process.argv.includes('--open') } = {}) {
  const server = http.createServer((req, res) => {
    try {
      handle(req, res);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String((err && err.stack) || err));
    }
  });
  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use. Is the dashboard already running?`);
      console.error('Pick another port with TOKENMETER_PORT, e.g. TOKENMETER_PORT=4546.');
      process.exit(1);
    }
    throw err;
  });
  server.listen(PORT, '127.0.0.1', () => {
    const url = `http://localhost:${PORT}`;
    console.log(`Tokenmeter dashboard: ${url}`);
    console.log(`Reading logs from:    ${PROJECTS_DIR}`);
    if (open) openBrowser(url);
  });
  return server;
}

module.exports = { start };

if (require.main === module) start();
