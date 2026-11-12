// Local preview:  node dev/server.js   then open http://localhost:5210
// With SUPABASE_URL and SUPABASE_ANON_KEY set, it talks to your real Supabase project.
// Without them, it swaps in dev/mock-supabase.js so the screens can be tried offline.
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const port = Number(process.env.PORT) || 5210;
const real = !!(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/api/config.js') {
    const cfg = real ? { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_ANON_KEY } : { url: 'mock', key: 'mock' };
    res.writeHead(200, { 'Content-Type': types['.js'], 'Cache-Control': 'no-store' });
    return res.end('window.NPC_CONFIG=' + JSON.stringify(cfg) + ';');
  }
  const file = path.join(root, url === '/' ? 'index.html' : url);
  if (!file.startsWith(root) || /[\\/]\.|[\\/]reference[\\/]/.test(file.slice(root.length))) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    if (path.basename(file) === 'index.html' && !real) {
      buf = Buffer.from(String(buf).replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@2"><\/script>/, '<script src="/dev/mock-supabase.js"></script>'));
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}).listen(port, () => console.log('Project Control preview on http://localhost:' + port + (real ? ' (real Supabase)' : ' (mock data)')));
