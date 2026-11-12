// A local mock endpoint for check-reviewer-live.ps1: answers every request
// with a short page and records it (method, path) in a log file, so a test
// can tell whether the reviewer reached a local address. Synthetic only.
// Usage: node mock-endpoint.mjs <port> <log file>
import fs from 'node:fs';
import http from 'node:http';

const port = Number(process.argv[2]);
const log = process.argv[3];
http
  .createServer((req, res) => {
    fs.appendFileSync(log, `${new Date().toISOString()} ${req.method} ${req.url}\n`);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('mock endpoint: nothing here\n');
  })
  .listen(port, '127.0.0.1');
