import { describe, it, expect } from 'vitest';
import {
  buildRegenPrompt, assertNoBundleText, scanOutputForBundleLeak, PROMPT_PACK_VERSION,
} from '../src/prompts.js';
import { MockLlmClient } from '../src/llm.js';
import { regenerateFromSpec } from '../src/regenerate.js';
import { parseSpec, type UnvibeSpec } from '../src/spec.js';

/**
 * Synthetic "platform bundle" — stands in for minified Lovable output.
 * Marker strings must never appear in regenerated code.
 */
export const SYNTHETIC_BUNDLE = `
;(function(){var __UNVIBE_CLEANROOM_MARKER_A1B2C3__="platform-secret-chunk-9f8e7d6c5b4a";
function $r(t){return t.split("").reverse().join("")}
var vendorChunk="__UNVIBE_CLEANROOM_MARKER_D4E5F6__-minified-vendor-bootstrap-sequence";
window.__LOVABLE_RUNTIME__={hydrate:function(){/* __UNVIBE_CLEANROOM_MARKER_070809__ */}};
})();
`.trim();

function testSpec(): UnvibeSpec {
  return parseSpec({
    specVersion: '1.0.0',
    source: { platform: 'lovable', url: 'https://demo.lovable.app', capturedAt: new Date().toISOString(), unvibeVersion: '0.1.0' },
    ownership: { attestedAt: new Date().toISOString(), method: 'flag' },
    routes: [{
      path: '/', title: 'Home', screenshot: 'screenshots/route-0.png', outgoingLinks: [],
      components: [{ name: 'HeroHeading', kind: 'hero', text: 'Welcome home', count: 1 }],
      apiCalls: [],
    }],
    endpoints: [{
      id: 'ep-1', method: 'GET', url: 'https://demo.lovable.app/api/projects',
      urlPattern: '/api/projects', origin: 'har', sampleCount: 2, routes: ['/'],
    }],
    entities: [{
      name: 'Project', tableName: 'projects',
      fields: [
        { name: 'id', type: 'uuid', nullable: false },
        { name: 'name', type: 'string', nullable: false },
      ],
      source: 'har-payload', evidence: ['GET /api/projects → response[]'],
    }],
    assets: [],
    auth: { provider: 'none', evidence: [] },
    thirdParty: [],
    gaps: [],
    stats: { pagesVisited: 1, requestsCaptured: 5, scriptsAnalyzed: 2 },
  });
}

describe('clean-room boundary', () => {
  it('prompt pack is versioned', () => {
    expect(PROMPT_PACK_VERSION).toMatch(/^\d+$/);
  });

  it('regen prompts contain spec JSON only — never bundle text', () => {
    const spec = testSpec();
    for (const kind of ['route-page', 'api-client', 'entity-types'] as const) {
      const messages = buildRegenPrompt({ spec, targetFile: 'x.tsx', kind, routePath: '/' });
      const blob = JSON.stringify(messages);
      for (const marker of ['__UNVIBE_CLEANROOM_MARKER_A1B2C3__', '__UNVIBE_CLEANROOM_MARKER_D4E5F6__', '__UNVIBE_CLEANROOM_MARKER_070809__', '__LOVABLE_RUNTIME__']) {
        expect(blob).not.toContain(marker);
      }
      // The prompt must carry the spec payload the mock provider reads.
      expect(blob).toContain('```spec-json');
    }
  });

  it('assertNoBundleText rejects bundle-shaped payloads loudly', () => {
    expect(() => assertNoBundleText(JSON.stringify({ ok: true }))).not.toThrow();
    expect(() => assertNoBundleText('x'.repeat(4001))).toThrow(/Clean-room violation/);
  });

  it('scanOutputForBundleLeak finds planted verbatim chunks', () => {
    const files = {
      'src/pages/home.tsx': 'export default function Home() { return <h1>hi</h1>; }',
      'src/evil.ts': `// oops ${SYNTHETIC_BUNDLE.slice(20, 140)}`,
    };
    const findings = scanOutputForBundleLeak(files, SYNTHETIC_BUNDLE);
    expect(findings.map((f) => f.file)).toEqual(['src/evil.ts']);
  });

  it('scanOutputForBundleLeak is clean for genuinely original code', () => {
    const files = { 'src/pages/home.tsx': 'export default function HomePage() {\n  return <main><h1>Welcome home</h1></main>;\n}\n' };
    expect(scanOutputForBundleLeak(files, SYNTHETIC_BUNDLE)).toEqual([]);
  });

  it('end-to-end: regenerate with mock LLM leaks zero marker strings', async () => {
    const spec = testSpec();
    const result = await regenerateFromSpec({
      spec,
      llm: new MockLlmClient(),
      scaffoldFiles: { 'package.json': '{}' },
      bundleTextForLeakScan: SYNTHETIC_BUNDLE,
      onProgress: () => {},
    });
    expect(result.leakFindings).toEqual([]);
    expect(result.promptsVersion).toBe(PROMPT_PACK_VERSION);
    // Every generated file is scanned for all three markers.
    const generated = Object.fromEntries(
      result.generatedByModel.map((f) => [f, result.files[f]]),
    );
    expect(result.generatedByModel.length).toBeGreaterThan(0);
    for (const marker of ['__UNVIBE_CLEANROOM_MARKER_A1B2C3__', '__UNVIBE_CLEANROOM_MARKER_D4E5F6__', '__UNVIBE_CLEANROOM_MARKER_070809__']) {
      for (const [file, content] of Object.entries(generated)) {
        expect(content, `${file} leaks ${marker}`).not.toContain(marker);
      }
    }
  });
});
