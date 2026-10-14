import { describe, it, expect } from 'vitest';
import {
  inferShape, normalizeUrlPattern, buildGaps,
} from '../src/analyze.js';
import type { SpecAuth, SpecEndpoint } from '../src/spec.js';

describe('normalizeUrlPattern', () => {
  it('replaces numeric and uuid segments with :param', () => {
    expect(normalizeUrlPattern('https://x.lovable.app/api/projects/123')).toBe('/api/projects/:param');
    expect(normalizeUrlPattern('https://x.lovable.app/api/projects/11111111-1111-4111-8111-111111111111'))
      .toBe('/api/projects/:param');
  });
  it('leaves static segments alone', () => {
    expect(normalizeUrlPattern('https://x.lovable.app/api/projects')).toBe('/api/projects');
  });
  it('replaces high-entropy token-like path segments with :param (secret hygiene)', () => {
    // Password-reset / invite tokens must never enter the spec verbatim.
    expect(normalizeUrlPattern('https://x.lovable.app/api/reset/aB3dE5fG7hJ9kL2mN4pQ6rS8tU0'))
      .toBe('/api/reset/:param');
    expect(normalizeUrlPattern('https://x.lovable.app/about-us')).toBe('/about-us');
  });
});

describe('inferShape', () => {
  it('infers primitives with formats', () => {
    expect(inferShape('11111111-1111-4111-8111-111111111111')).toMatchObject({ type: 'string', format: 'uuid' });
    expect(inferShape('2026-01-05T10:00:00Z')).toMatchObject({ type: 'string', format: 'date-time' });
    expect(inferShape('a@b.com')).toMatchObject({ type: 'string', format: 'email' });
    expect(inferShape(42)).toMatchObject({ type: 'number' });
    expect(inferShape(true)).toMatchObject({ type: 'boolean' });
    expect(inferShape(null)).toMatchObject({ type: 'null' });
  });

  it('infers objects with required fields', () => {
    const s = inferShape({ id: 'x', stars: 3, nick: null });
    expect(s.type).toBe('object');
    expect(s.properties?.stars).toMatchObject({ type: 'number' });
    expect(s.required).toContain('id');
    expect(s.required).not.toContain('nick');
  });

  it('infers arrays with merged item shapes', () => {
    const s = inferShape([{ a: 1 }, { a: 2, b: 'x' }]);
    expect(s.type).toBe('array');
    expect(s.items?.type).toBe('object');
    expect(s.items?.properties?.a).toMatchObject({ type: 'number' });
  });
});

describe('buildGaps honesty', () => {
  const authNone: SpecAuth = { provider: 'none', evidence: [] };
  const noEndpoints: SpecEndpoint[] = [];

  it('always lists edge functions, triggers, storage, secrets — even with no backend observed', () => {
    const gaps = buildGaps(authNone, noEndpoints, []);
    const cats = gaps.map((g) => g.category);
    for (const c of ['edge-function', 'database-trigger', 'storage-bucket', 'secret'] as const) {
      expect(cats).toContain(c);
    }
    // Every gap is explicitly unrecoverable with manual steps.
    for (const g of gaps) {
      expect(g.recoverable).toBe(false);
      expect(g.manualSteps.length).toBeGreaterThan(0);
      expect(g.description.length).toBeGreaterThan(0);
    }
  });

  it('adds RLS + auth gaps when supabase is detected, payment gap for stripe', () => {
    const auth: SpecAuth = { provider: 'supabase', evidence: ['bundle: supabase marker strings'] };
    const eps = [{
      id: 'ep-1', method: 'GET', url: 'https://example-test.supabase.co/rest/v1/projects',
      urlPattern: '/rest/v1/projects', origin: 'har', sampleCount: 1, routes: [],
    } as SpecEndpoint];
    const gaps = buildGaps(auth, eps, [{ name: 'stripe', category: 'payments', evidence: [] }]);
    const cats = gaps.map((g) => g.category);
    expect(cats).toContain('rls-policy');
    expect(cats).toContain('auth-config');
    expect(cats).toContain('payment-flow');
    // No invented recovery: RLS gap must say policies are NOT created.
    const rls = gaps.find((g) => g.category === 'rls-policy')!;
    expect(rls.description).toMatch(/invisible|server-side/i);
  });

  it('never claims to have recovered user data', () => {
    const gaps = buildGaps({ provider: 'supabase', evidence: [] }, [], []);
    const authGap = gaps.find((g) => g.category === 'auth-config')!;
    expect(authGap.description).toMatch(/cannot be exported|not migrated/i);
    // The runbook is explicit: Unvibe never automates user-table export.
    expect(authGap.manualSteps.join(' ')).toMatch(/never automates user-table export/i);
    expect(authGap.manualSteps.join(' ')).not.toMatch(/unvibe will migrate/i);
  });
});
