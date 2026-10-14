import { describe, it, expect } from 'vitest';
import {
  renderScaffold, renderDrizzleSchema, renderSqlMigration, renderAppTsx,
} from '../src/scaffold.js';
import { parseSpec, type UnvibeSpec } from '@tamtunnel/unvibe-core';

function spec(): UnvibeSpec {
  return parseSpec({
    specVersion: '1.0.0',
    source: { platform: 'lovable', url: 'https://demo.lovable.app', capturedAt: new Date().toISOString(), unvibeVersion: '0.1.0' },
    ownership: { attestedAt: new Date().toISOString(), method: 'flag' },
    routes: [
      { path: '/', title: 'Home', screenshot: 'screenshots/a.png', outgoingLinks: ['/about'], components: [], apiCalls: [] },
      { path: '/about', title: 'About', screenshot: 'screenshots/b.png', outgoingLinks: [], components: [], apiCalls: [] },
    ],
    endpoints: [],
    entities: [{
      name: 'Project', tableName: 'projects',
      fields: [
        { name: 'id', type: 'uuid', nullable: false },
        { name: 'name', type: 'string', nullable: false },
        { name: 'stars', type: 'number', nullable: true },
        { name: 'created_at', type: 'date', nullable: true },
      ],
      source: 'har-payload', evidence: ['GET /api/projects → response[]'],
    }],
    assets: [],
    auth: { provider: 'supabase', evidence: ['bundle: supabase marker strings'] },
    thirdParty: [],
    gaps: [],
    stats: { pagesVisited: 2, requestsCaptured: 3, scriptsAnalyzed: 1 },
  });
}

describe('renderScaffold', () => {
  it('renders the full deterministic file set', () => {
    const files = renderScaffold(spec());
    for (const f of [
      'package.json', 'vite.config.ts', 'tsconfig.json', 'index.html',
      'src/main.tsx', 'src/App.tsx', 'src/index.css',
      'src/lib/http.ts', 'src/lib/auth.ts',
      'src/components/ui/button.tsx', 'src/components/ui/card.tsx', 'src/components/ui/input.tsx',
      'drizzle/schema.ts', 'drizzle.config.ts', 'supabase/migrations/0001_unvibe.sql',
      'docker-compose.yml', 'Dockerfile', 'nginx.conf', '.env.example', '.gitignore',
      'docs/auth-migration-runbook.md', 'README.md', 'unvibe-spec.json',
    ]) {
      expect(files[f], `missing ${f}`).toBeTruthy();
    }
    // The spec is checked into the output repo.
    expect(JSON.parse(files['unvibe-spec.json']).specVersion).toBe('1.0.0');
  });

  it('App.tsx wires every spec route', () => {
    const app = renderAppTsx(spec());
    expect(app).toContain('path="/"');
    expect(app).toContain('path="/about"');
    expect(app).toContain('HomePage');
    expect(app).toContain('AboutPage');
  });

  it('drizzle schema + SQL migration come from observed entities only', () => {
    const s = spec();
    const drizzle = renderDrizzleSchema(s.entities);
    expect(drizzle).toContain('pgTable("projects"');
    expect(drizzle).toContain('uuid("id").primaryKey()');
    expect(drizzle).toContain('WITHOUT RLS');
    const sql = renderSqlMigration(s.entities);
    expect(sql).toContain('create table if not exists "projects"');
    expect(sql).toContain('"created_at" timestamptz');
    expect(sql).toContain('no RLS policies');
  });

  it('auth adapter points at the user\'s own instance via env vars', () => {
    const files = renderScaffold(spec());
    expect(files['src/lib/auth.ts']).toContain('VITE_SUPABASE_URL');
    expect(files['src/lib/auth.ts']).not.toContain('sb_publishable');
    expect(files['.env.example']).toContain('VITE_SUPABASE_ANON_KEY=');
  });

  it('renders an empty-data-model scaffold honestly when nothing was observed', () => {
    const s = spec();
    s.entities = [];
    const files = renderScaffold(s);
    expect(files['drizzle/schema.ts']).toContain('no entities were observed');
    expect(files['supabase/migrations/0001_unvibe.sql']).toContain('no entities were observed');
  });

  it('docker-compose ships a self-hosted postgres starting point', () => {
    const files = renderScaffold(spec());
    expect(files['docker-compose.yml']).toContain('supabase/postgres');
    expect(files['docker-compose.yml']).toContain('postgrest');
  });
});
