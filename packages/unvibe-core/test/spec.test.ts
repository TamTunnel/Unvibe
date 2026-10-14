import { describe, it, expect } from 'vitest';
import { parseSpec, validateSpec, SPEC_VERSION, type UnvibeSpec } from '../src/spec.js';

function validSpec(): Record<string, unknown> {
  return {
    specVersion: SPEC_VERSION,
    source: {
      platform: 'lovable',
      url: 'https://demo.lovable.app',
      capturedAt: new Date().toISOString(),
      unvibeVersion: '0.1.0',
    },
    ownership: { attestedAt: new Date().toISOString(), method: 'flag' },
    routes: [{ path: '/', title: 'Home', screenshot: 'screenshots/route-0.png', outgoingLinks: [], components: [], apiCalls: [] }],
    endpoints: [],
    entities: [],
    assets: [],
    auth: { provider: 'none', evidence: [] },
    thirdParty: [],
    gaps: [],
    stats: { pagesVisited: 1, requestsCaptured: 0, scriptsAnalyzed: 0 },
  };
}

describe('spec schema', () => {
  it('accepts a valid spec', () => {
    const spec = parseSpec(validSpec());
    expect(spec.specVersion).toBe('1.0.0');
    expect(validateSpec(validSpec())).toEqual([]);
  });

  it('rejects a wrong spec version', () => {
    const bad = validSpec();
    bad.specVersion = '2.0.0';
    expect(validateSpec(bad).length).toBeGreaterThan(0);
    expect(() => parseSpec(bad)).toThrow();
  });

  it('rejects a spec with zero routes', () => {
    const bad = validSpec();
    bad.routes = [];
    expect(() => parseSpec(bad)).toThrow();
  });

  it('rejects non-lovable platform values', () => {
    const bad = validSpec() as { source: { platform: string } };
    (bad.source as { platform: string }).platform = 'v0';
    expect(() => parseSpec(bad)).toThrow();
  });

  it('rejects gaps marked recoverable:true (gaps are unrecoverable by definition)', () => {
    const bad = validSpec() as unknown as { gaps: unknown[] };
    bad.gaps = [{
      category: 'rls-policy', title: 'x', description: 'y',
      manualSteps: ['do it'], recoverable: true,
    }];
    expect(() => parseSpec(bad)).toThrow();
  });

  it('validateSpec returns human-readable issues', () => {
    const issues = validateSpec({ specVersion: '1.0.0' });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]).toMatch(/source|routes/);
  });

  it('round-trips a full spec through JSON', () => {
    const spec = parseSpec(validSpec()) as UnvibeSpec;
    expect(parseSpec(JSON.parse(JSON.stringify(spec)))).toEqual(spec);
  });
});
