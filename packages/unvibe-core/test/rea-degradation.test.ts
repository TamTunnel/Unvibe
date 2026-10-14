import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdapter, localReaBin } from '../src/rea-adapter.js';

/**
 * m14: the REA `auto` path is exercised here for its degradation behavior.
 * With UNVIBE_REA_NO_NPX=1 (no network fetch allowed) and no local install,
 * the auto adapter must report unavailable and fall back to the local
 * scanner — never throw, never hang.
 */
describe('ReaCliAdapter degradation (auto mode, no REA present)', () => {
  const OLD = process.env.UNVIBE_REA_NO_NPX;

  afterEach(() => {
    if (OLD === undefined) delete process.env.UNVIBE_REA_NO_NPX;
    else process.env.UNVIBE_REA_NO_NPX = OLD;
  });

  it('available() is false and bundle/HAR calls fall back to local (no network)', async () => {
    if (localReaBin()) {
      console.warn('rea-agents is installed locally — skipping no-REA degradation test');
      return;
    }
    process.env.UNVIBE_REA_NO_NPX = '1';
    const adapter = createAdapter('auto');
    expect(await adapter.available()).toBe(false);

    const dir = await mkdtemp(join(tmpdir(), 'unvibe-rea-deg-'));
    await writeFile(join(dir, 'app.js'), 'fetch("/api/projects");');
    const inv = await adapter.analyzeBundle(dir, 'https://demo.lovable.app');
    expect(inv.provenance).toBe('local');
    expect(inv.referencedEndpoints).toContain('/api/projects');

    const harPath = join(dir, 't.har');
    await writeFile(harPath, JSON.stringify({ log: { entries: [] } }));
    const cands = await adapter.inspectHar(harPath);
    expect(cands).toEqual([]);
  });
});
