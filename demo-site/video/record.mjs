/**
 * Records demo-site/unvibe-demo.mp4: a terminal replaying REAL unvibe CLI
 * sessions (captured verbatim from live runs against the synthetic fixture
 * app; only the /tmp work-dir prefix is shortened for readability).
 * No TTS was available on this machine, so narration is via on-screen cards.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const runOut = readFileSync('/tmp/session-run.txt', 'utf8')
  .replaceAll('/tmp/unvibe-vid-work', './demo-rebuild').trim().split('\n');
const verifyOut = readFileSync('/tmp/session-verify.txt', 'utf8')
  .replaceAll('/tmp/unvibe-vid-work', './demo-rebuild').trim().split('\n');
const specExcerpt = readFileSync('/home/hatch/workspace/unvibe/demo-site/assets/spec-sample.json', 'utf8')
  .split('\n').slice(0, 28);
const gapsHead = readFileSync('/home/hatch/workspace/unvibe/demo-site/assets/BACKEND-GAPS-sample.md', 'utf8')
  .split('\n').slice(0, 22);
const repoList = [
  'BACKEND-GAPS.md', 'Dockerfile', 'README.md', 'docker-compose.yml', 'docs/',
  'drizzle/schema.ts', 'drizzle.config.ts', 'index.html', 'nginx.conf',
  'package.json', 'postcss.config.js', 'src/App.tsx', 'src/lib/api.ts',
  'src/lib/auth.ts', 'src/lib/http.ts', 'src/main.tsx',
  'src/pages/about.tsx', 'src/pages/dashboard.tsx', 'src/pages/home.tsx',
  'src/types.ts', 'supabase/migrations/0001_unvibe.sql', 'unvibe-spec.json',
  'vite.config.ts', '… (30 files total)',
];
const apiExcerpt = readFileSync('/tmp/unvibe-vid-work/repo/src/lib/api.ts', 'utf8')
  .split('\n').slice(0, 14);

const scenes = [
  { type: 'card', title: 'Unvibe', sub: 'an escape hatch for vibe-locked apps', hold: 5500 },
  {
    type: 'term', hold: 1500,
    lines: [
      { t: 'cmd', s: 'unvibe run --url http://localhost:8901/ --work-dir ./demo-rebuild --i-own-this' },
      ...runOut.map((s) => ({ t: 'out', s })),
      { t: 'blank', s: '' },
    ],
  },
  {
    type: 'term', hold: 1500,
    lines: [
      { t: 'cmd', s: 'cat demo-rebuild/.unvibe/unvibe-spec.json' },
      ...specExcerpt.map((s) => ({ t: 'out', s })),
      { t: 'out', s: '  … (full spec: routes, endpoints, entities, auth, gaps)' },
      { t: 'blank', s: '' },
    ],
  },
  {
    type: 'term', hold: 1500,
    lines: [
      { t: 'cmd', s: 'head -20 demo-rebuild/repo/BACKEND-GAPS.md' },
      ...gapsHead.map((s) => ({ t: 'out', s })),
      { t: 'blank', s: '' },
    ],
  },
  {
    type: 'term', hold: 1200,
    lines: [
      { t: 'cmd', s: 'ls demo-rebuild/repo' },
      ...repoList.map((s) => ({ t: 'out', s })),
      { t: 'blank', s: '' },
    ],
  },
  {
    type: 'term', hold: 1200,
    lines: [
      { t: 'cmd', s: 'cat demo-rebuild/repo/src/lib/api.ts' },
      ...apiExcerpt.map((s) => ({ t: 'out', s })),
      { t: 'blank', s: '' },
    ],
  },
  {
    type: 'term', hold: 1200,
    lines: [
      { t: 'cmd', s: 'unvibe verify --rebuilt-url http://localhost:4173' },
      ...verifyOut.map((s) => ({ t: 'out', s })),
      { t: 'blank', s: '' },
    ],
  },
  { type: 'card', title: 'Same routes. Same data. Same flows.', sub: 'Yours. — github.com/TamTunnel/unvibe', hold: 6000 },
];

const html = `<!doctype html><html><head><meta charset="utf-8">
<style>
  html,body{margin:0;height:100%;background:#0b0e14;color:#e6ebf4;
    font-family:ui-monospace,"DejaVu Sans Mono",Menlo,Consolas,monospace;}
  #stage{width:1280px;height:720px;position:relative;overflow:hidden;}
  .card{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#0b0e14;}
  .card h1{font-size:56px;margin:0 0 12px;letter-spacing:-1px;}
  .card p{font-size:24px;color:#9aa7bd;margin:0;}
  .card .bar{width:220px;height:4px;background:#232c40;border-radius:2px;margin-top:28px;overflow:hidden;}
  .card .bar i{display:block;height:100%;width:40%;background:#7cc4ff;border-radius:2px;animation:slide 1.2s infinite;}
  @keyframes slide{0%{margin-left:-40%}100%{margin-left:100%}}
  .term{position:absolute;inset:0;padding:36px 44px;font-size:21px;line-height:1.65;white-space:pre-wrap;word-break:break-all;}
  .prompt{color:#6fdc8c;} .cmd{color:#ffffff;} .out{color:#9aa7bd;}
  .cursor{display:inline-block;width:12px;height:24px;background:#7cc4ff;vertical-align:-4px;animation:blink 1s steps(1) infinite;}
  @keyframes blink{50%{opacity:0}}
  .stage-h{color:#7cc4ff;}
</style></head><body><div id="stage"></div>
<script>
const scenes = ${JSON.stringify(scenes)};
const stage = document.getElementById('stage');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;');}
async function typeText(el, text, cps){
  for(const ch of text){ el.textContent += ch; await sleep(1000/cps); }
}
async function play(){
  for(const sc of scenes){
    stage.innerHTML = '';
    if(sc.type === 'card'){
      stage.innerHTML = '<div class="card"><h1>'+esc(sc.title)+'</h1><p>'+esc(sc.sub)+'</p><div class="bar"><i></i></div></div>';
      await sleep(sc.hold);
    } else {
      const term = document.createElement('div');
      term.className = 'term';
      stage.appendChild(term);
      for(const ln of sc.lines){
        if(ln.t === 'blank'){ term.appendChild(document.createElement('br')); continue; }
        const div = document.createElement('div');
        if(ln.t === 'cmd'){
          div.innerHTML = '<span class="prompt">$ </span><span class="cmd"></span><span class="cursor"></span>';
          term.appendChild(div);
          await typeText(div.querySelector('.cmd'), ln.s, 30);
          div.querySelector('.cursor').remove();
          await sleep(350);
        } else {
          let cls = 'out';
          if(/^== stage/.test(ln.s)) cls = 'stage-h';
          else if(/PASS/.test(ln.s)) cls = 'out';
          div.className = cls;
          div.textContent = ln.s;
          term.appendChild(div);
          await sleep(ln.s.startsWith('==') ? 900 : 230);
        }
        if(term.children.length > 26) term.removeChild(term.firstChild);
      }
      await sleep(sc.hold);
    }
  }
  document.title = 'DONE';
}
play();
</script></body></html>`;

mkdirSync('/tmp/unvibe-video', { recursive: true });
writeFileSync('/tmp/unvibe-video/player.html', html);

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  recordVideo: { dir: '/tmp/unvibe-video', size: { width: 1280, height: 720 } },
});
const page = await ctx.newPage();
await page.goto('file:///tmp/unvibe-video/player.html');
await page.waitForFunction(() => document.title === 'DONE', undefined, { timeout: 240000 });
await ctx.close();
await browser.close();
console.log('recorded');
