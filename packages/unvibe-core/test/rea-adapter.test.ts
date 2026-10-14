import { describe, it, expect } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  LocalAdapter, localBundleScan, localHarParse, createAdapter,
} from '../src/rea-adapter.js';

describe('localBundleScan (REA fallback backbone)', () => {
  it('extracts fetch call-sites, imports, and provider hints', async () => {
    const dir = join(tmpdir(), `unvibe-scan-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    try {
      await writeFile(join(dir, 'app.js'), `
        import { x } from "./lib.js";
        const supabase = createClient("https://example-test.supabase.co", "k");
        fetch("/api/projects").then(r => r.json());
        axios.post("https://payments.example.com/v1/charges", {});
      `);
      await writeFile(join(dir, 'lib.js'), 'export const x = 1;');
      const inv = await localBundleScan(dir);
      expect(inv.scripts).toHaveLength(2);
      expect(inv.importGraph).toContainEqual({ from: 'app.js', to: './lib.js' });
      expect(inv.referencedEndpoints).toContain('/api/projects');
      expect(inv.referencedEndpoints).toContain('https://payments.example.com/v1/charges');
      expect(inv.providerHints).toContain('supabase');
      expect(inv.provenance).toBe('local');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns an empty inventory for a missing directory (never throws)', async () => {
    const inv = await localBundleScan(join(tmpdir(), 'unvibe-nope-missing-dir'));
    expect(inv.scripts).toEqual([]);
  });
});

describe('localHarParse', () => {
  it('parses entries with JSON bodies', async () => {
    const dir = join(tmpdir(), `unvibe-har-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const harPath = join(dir, 't.har');
    try {
      await writeFile(harPath, JSON.stringify({
        log: {
          entries: [{
            request: { method: 'get', url: 'https://x.lovable.app/api/projects', postData: undefined },
            response: {
              status: 200,
              headers: [{ name: 'content-type', value: 'application/json' }],
              content: { mimeType: 'application/json', text: JSON.stringify([{ id: 1 }]) },
            },
          }],
        },
      }));
      const out = await localHarParse(harPath);
      expect(out).toHaveLength(1);
      expect(out[0].method).toBe('GET');
      expect(out[0].responseBody).toEqual([{ id: 1 }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('adapters', () => {
  it('LocalAdapter is always available and scans locally', async () => {
    const a = new LocalAdapter();
    expect(await a.available()).toBe(true);
    expect(a.name).toBe('local-fallback');
  });

  it('createAdapter("off") returns the local fallback', () => {
    expect(createAdapter('off').name).toBe('local-fallback');
  });

  it('createAdapter("auto") returns the REA CLI adapter', () => {
    expect(createAdapter('auto').name).toContain('rea-cli');
  });
});
