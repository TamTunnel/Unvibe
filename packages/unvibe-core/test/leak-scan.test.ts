import { describe, it, expect } from 'vitest';
import { scanOutputForBundleLeak, normalizeForLeakScan } from '../src/prompts.js';
import { regenerateFromSpec } from '../src/regenerate.js';
import { MockLlmClient } from '../src/llm.js';
import { parseSpec, type UnvibeSpec } from '../src/spec.js';

const MARKER = '__UNVIBE_LEAKSCAN_MARKER_9f8e7d6c5b4a__';

/**
 * Judge #2 regression tests: the verbatim-leak scan must not be trivially
 * bypassable.
 */
describe('scanOutputForBundleLeak hardening', () => {
  it('(a) a one-char difference in a longer copy is still detected', () => {
    const bundle = `var x = "${MARKER}"; function alpha_beta_gamma_delta() { return "0123456789abcdef0123456789"; }`;
    // One char changed in the middle of an 80+ char copy.
    const copy = bundle.replace('alpha_beta_gamma_delta', 'alpha_beta_gammX_delta');
    const findings = scanOutputForBundleLeak({ 'src/a.ts': `// rebuilt\n${copy}\n` }, bundle);
    expect(findings.map((f) => f.file)).toEqual(['src/a.ts']);
  });

  it('(b) a 79-char verbatim copy is detected (no 80-char cliff)', () => {
    const chunk79 = 'a'.repeat(20) + MARKER + 'b'.repeat(79 - 20 - MARKER.length);
    expect(chunk79).toHaveLength(79);
    const bundle = `prefix ${chunk79} suffix`;
    const findings = scanOutputForBundleLeak({ 'src/a.ts': `const q = "${chunk79}";` }, bundle);
    expect(findings.map((f) => f.file)).toEqual(['src/a.ts']);
  });

  it('(b) reporting is length-weighted: longer copies score higher', () => {
    const long = `start ${MARKER}${'z'.repeat(120)} end`;
    const short = `start ${MARKER}${'z'.repeat(30)} end`;
    const bundle = `${long}\n${short}`;
    const findings = scanOutputForBundleLeak(
      { 'src/long.ts': long, 'src/short.ts': short },
      bundle,
    );
    const byFile = Object.fromEntries(findings.map((f) => [f.file, f.chunkLength]));
    expect(byFile['src/long.ts']).toBeGreaterThan(byFile['src/short.ts']);
  });

  it('(c) bundle tails are scanned (no chunk-count cap)', () => {
    // Old code capped at 20k chunks ≈ 800KB; a marker past that was invisible.
    const tail = `tail ${MARKER} ${'q'.repeat(60)}`;
    const bundle = 'x'.repeat(900_000) + '\n' + tail + '\n' + 'y'.repeat(50_000);
    const findings = scanOutputForBundleLeak({ 'src/a.ts': `// ${tail}` }, bundle);
    expect(findings.map((f) => f.file)).toEqual(['src/a.ts']);
  }, 30000);

  it('normalization defeats reindented / re-quoted copies', () => {
    const bundle = `function   foo( ) {\n\treturn '${MARKER}';\n}`;
    const copy = `function foo(){return "${MARKER}";}`;
    expect(normalizeForLeakScan(bundle)).toContain(normalizeForLeakScan(copy).slice(0, 24));
    const findings = scanOutputForBundleLeak({ 'src/a.ts': copy }, bundle);
    expect(findings.map((f) => f.file)).toEqual(['src/a.ts']);
  });

  it('genuinely original code stays clean', () => {
    const bundle = `var ${MARKER} = "platform-secret-chunk-9f8e7d6c5b4a"; function $r(t){return t;}`;
    const files = { 'src/pages/home.tsx': 'export default function HomePage() {\n  return <main><h1>Welcome</h1></main>;\n}\n' };
    expect(scanOutputForBundleLeak(files, bundle)).toEqual([]);
  });
});

function testSpec(): UnvibeSpec {
  return parseSpec({
    specVersion: '1.0.0',
    source: { platform: 'lovable', url: 'https://demo.lovable.app', capturedAt: new Date().toISOString(), unvibeVersion: '0.1.0' },
    ownership: { attestedAt: new Date().toISOString(), method: 'flag' },
    routes: [{
      path: '/', title: 'Home', screenshot: 'screenshots/route-0.png', outgoingLinks: [],
      components: [], apiCalls: [],
    }],
    endpoints: [], entities: [], assets: [],
    auth: { provider: 'none', evidence: [] },
    thirdParty: [], gaps: [],
    stats: { pagesVisited: 1, requestsCaptured: 0, scriptsAnalyzed: 0 },
  });
}

describe('leak scan skip is loud, never silent (Judge #2d)', () => {
  it('regenerateFromSpec reports leakScanSkipped when no bundle text is available', async () => {
    const result = await regenerateFromSpec({
      spec: testSpec(),
      llm: new MockLlmClient(),
      scaffoldFiles: {},
      bundleTextForLeakScan: undefined,
      onProgress: () => {},
    });
    expect(result.leakScanSkipped).toBe(true);
    expect(result.leakFindings).toEqual([]);
  });

  it('reports leakScanSkipped=false when bundle text was scanned', async () => {
    const result = await regenerateFromSpec({
      spec: testSpec(),
      llm: new MockLlmClient(),
      scaffoldFiles: {},
      bundleTextForLeakScan: 'var harmless = 1;',
      onProgress: () => {},
    });
    expect(result.leakScanSkipped).toBe(false);
  });
});
