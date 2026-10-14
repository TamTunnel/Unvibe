import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createLlmClient, MockLlmClient, OpenAiCompatibleClient, AnthropicClient,
} from '../src/llm.js';

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.UNVIBE_API_KEY;
});

describe('createLlmClient', () => {
  it('creates a mock client without any key', () => {
    const c = createLlmClient({ provider: 'mock', model: 'x' });
    expect(c).toBeInstanceOf(MockLlmClient);
  });

  it('refuses to create a networked client without a key', () => {
    expect(() => createLlmClient({ provider: 'openai', model: 'gpt-4o-mini' }))
      .toThrow(/UNVIBE_API_KEY/);
  });

  it('accepts a key from the environment', () => {
    process.env.UNVIBE_API_KEY = 'sk_test_EXAMPLE_DO_NOT_USE';
    const c = createLlmClient({ provider: 'anthropic', model: 'claude-x' });
    expect(c).toBeInstanceOf(AnthropicClient);
  });
});

describe('OpenAiCompatibleClient', () => {
  it('POSTs a chat-completions request with bearer auth', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ choices: [{ message: { content: 'export const x = 1;' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const c = new OpenAiCompatibleClient('gpt-4o-mini', 'sk_test_EXAMPLE_DO_NOT_USE', 'https://api.example.com/v1');
    const out = await c.complete([{ role: 'user', content: 'hi' }]);
    expect(out).toBe('export const x = 1;');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk_test_EXAMPLE_DO_NOT_USE');
    const body = JSON.parse(init.body as string) as { model: string; messages: unknown[] };
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.messages).toHaveLength(1);
  });

  it('throws a useful error on HTTP failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    const c = new OpenAiCompatibleClient('m', 'sk_test_EXAMPLE_DO_NOT_USE', 'https://api.example.com/v1');
    await expect(c.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow(/401/);
  });
});

describe('MockLlmClient', () => {
  it('renders a route page from spec components only', async () => {
    const c = new MockLlmClient();
    const specJson = JSON.stringify({
      kind: 'route-page',
      routes: [{ path: '/about', components: [{ name: 'AboutHeading', kind: 'heading', text: 'About us' }] }],
    });
    const out = await c.complete([
      { role: 'system', content: 'sys' },
      { role: 'user', content: `TARGET-FILE: src/pages/about.tsx\ntask\n\`\`\`spec-json\n${specJson}\n\`\`\`` },
    ]);
    expect(out).toContain('AboutPage');
    expect(out).toContain('About us');
  });

  it('renders an api client preserving method + url pattern', async () => {
    const c = new MockLlmClient();
    const specJson = JSON.stringify({
      kind: 'api-client',
      endpoints: [{ id: 'ep-1', method: 'POST', urlPattern: '/api/contact' }],
    });
    const out = await c.complete([
      { role: 'user', content: `TARGET-FILE: src/lib/api.ts\n\`\`\`spec-json\n${specJson}\n\`\`\`` },
    ]);
    expect(out).toContain('"/api/contact"');
    expect(out).toContain('"POST"');
  });

  it('renders entity interfaces from spec entities', async () => {
    const c = new MockLlmClient();
    const specJson = JSON.stringify({
      kind: 'entity-types',
      entities: [{ name: 'Project', fields: [{ name: 'name', type: 'string' }, { name: 'stars', type: 'number' }] }],
    });
    const out = await c.complete([
      { role: 'user', content: `TARGET-FILE: src/types.ts\n\`\`\`spec-json\n${specJson}\n\`\`\`` },
    ]);
    expect(out).toContain('interface Project');
    expect(out).toContain('stars: number');
  });
});

describe('mock api-client body forwarding (M5)', () => {
  it('renders (params, body?) and passes body to apiRequest', async () => {
    const c = new MockLlmClient();
    const specJson = JSON.stringify({
      kind: 'api-client',
      endpoints: [{ id: 'ep-1', method: 'POST', urlPattern: '/api/contact' }],
    });
    const out = await c.complete([
      { role: 'user', content: `TARGET-FILE: src/lib/api.ts\n\`\`\`spec-json\n${specJson}\n\`\`\`` },
    ]);
    expect(out).toContain('body?: unknown');
    expect(out).toContain('apiRequest("POST", "/api/contact", params, body)');
  });
});
