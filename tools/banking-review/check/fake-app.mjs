// A stand-in for the app's /api/banking-access, for check-promotion.ps1:
// news enabled, a fresh fetch, one lead (or the leads in a JSON file).
// Usage: node fake-app.mjs <port> [leads.json]
import fs from 'node:fs';
import http from 'node:http';

const port = Number(process.argv[2] ?? 4199);
const candidates = process.argv[3]
  ? JSON.parse(fs.readFileSync(process.argv[3], 'utf8'))
  : [{ id: 'check-lead-1', title: 'Check lead', url: 'https://example.invalid/check-lead-1', domain: 'example.invalid' }];
http
  .createServer((req, res) => {
    if (!req.url.startsWith('/api/banking-access')) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        countries: [],
        events: [],
        problems: [],
        news: {
          enabled: true,
          status: 'ok',
          fetchedAt: Date.now(),
          consecutiveFailures: 0,
          candidates,
        },
      }),
    );
  })
  .listen(port, '127.0.0.1');
