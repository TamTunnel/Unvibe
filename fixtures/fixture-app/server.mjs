/**
 * Synthetic fixture app — stands in for a Lovable-built app during tests
 * and the demo video. Three routes, a tiny JSON API, and bundle text that
 * carries:
 *  - supabase marker strings (auth detection),
 *  - __UNVIBE_CLEANROOM_MARKER_* strings (clean-room leak tests),
 *  - fetch() call-sites (endpoint inventory).
 *
 * All keys/tokens are obviously fake placeholders.
 */
import http from 'node:http';

const PORT = Number(process.env.FIXTURE_PORT ?? 0); // 0 = ephemeral; tests parse the real port from stdout

// Obviously-fake placeholder credentials (never realistic-looking).
const FAKE_SUPABASE_URL = 'https://example-test.supabase.co';
const FAKE_ANON_KEY = 'sb_publishable_EXAMPLE_DO_NOT_USE';

const BUNDLE_JS = `
// fixture bundle — synthetic platform output
const __UNVIBE_CLEANROOM_MARKER_A1B2C3__ = "do-not-leak-into-regenerated-code";
const SUPABASE_URL = "${FAKE_SUPABASE_URL}";
const SUPABASE_ANON_KEY = "${FAKE_ANON_KEY}";
function boot() {
  var __UNVIBE_CLEANROOM_MARKER_D4E5F6__ = 42;
  fetch("/api/projects").then(function(r){ return r.json(); }).then(renderProjects);
  document.getElementById("contact-form")?.addEventListener("submit", function(e) {
    e.preventDefault();
    fetch("/api/contact", { method: "POST", headers: {"content-type":"application/json"},
      body: JSON.stringify({ name: "Ada", email: "ada@example.com" }) });
  });
}
function renderProjects(items) {
  var el = document.getElementById("project-list");
  el.innerHTML = items.map(function(p){ return "<li>" + p.name + " (" + p.stars + " stars)</li>"; }).join("");
}
boot();
// __UNVIBE_CLEANROOM_MARKER_070809__ trailing marker
`;

function page(title, body, extra = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem}nav a{margin-right:1rem}</style>
</head><body>
<nav><a href="/">Home</a><a href="/about">About</a><a href="/dashboard">Dashboard</a></nav>
<h1>${title}</h1>
${body}
<script src="/assets/app.js"></script>
${extra}
</body></html>`;
}

const PROJECTS = [
  { id: '11111111-1111-4111-8111-111111111111', name: 'Alpha', stars: 12, created_at: '2026-01-05T10:00:00Z', public: true },
  { id: '22222222-2222-4222-8222-222222222222', name: 'Beta', stars: 7, created_at: '2026-02-10T10:00:00Z', public: false },
];

const server = http.createServer((req, res) => {
  const u = new URL(req.url ?? '/', 'http://localhost');
  const json = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (u.pathname === '/assets/app.js') {
    res.writeHead(200, { 'content-type': 'application/javascript' });
    res.end(BUNDLE_JS);
    return;
  }
  if (u.pathname === '/api/projects' && req.method === 'GET') return json(200, PROJECTS);
  if (u.pathname.startsWith('/api/projects/') && req.method === 'GET') {
    const p = PROJECTS.find((x) => x.id === u.pathname.split('/').pop());
    return p ? json(200, p) : json(404, { error: 'not found' });
  }
  if (u.pathname === '/api/contact' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => json(200, { ok: true }));
    return;
  }
  const routes = {
    '/': page('Fixture Home', '<p>Welcome to the fixture app.</p><ul id="project-list"></ul>'),
    '/about': page('About', '<p>About the fixture app. Built for Unvibe tests.</p>'),
    '/dashboard': page(
      'Dashboard',
      '<form id="contact-form"><input name="name" placeholder="Name"><button>Send</button></form>',
    ),
  };
  const html = routes[u.pathname];
  if (html) {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html);
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : PORT;
  console.log(`fixture-app listening on http://localhost:${port}`);
});
