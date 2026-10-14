/**
 * Provider-agnostic LLM client for the regenerate stage.
 *
 * - Bring-your-own-key: reads UNVIBE_API_KEY (or an explicit apiKey).
 * - OpenAI-compatible HTTPS endpoint (works with OpenAI, OpenRouter,
 *   Together, vLLM, Ollama, …) and Anthropic's Messages API.
 * - `mock` provider: fully deterministic, spec-driven codegen used by the
 *   test suite and offline demos. It writes ORIGINAL code from the spec —
 *   it never sees bundle text (the clean-room boundary is structural:
 *   regenerate prompts only ever contain spec JSON).
 *
 * The LLM is used ONLY in `regenerate`. Capture and analyze are
 * deterministic; analyze uses the LLM at most for naming/summarizing.
 */
export type LlmProvider = 'openai' | 'anthropic' | 'mock';

export interface LlmConfig {
  provider: LlmProvider;
  model: string;
  apiKey?: string;
  baseUrl?: string; // openai-compatible base; defaults per provider
  maxTokens?: number;
  temperature?: number;
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmClient {
  readonly provider: LlmProvider;
  readonly model: string;
  complete(messages: LlmMessage[]): Promise<string>;
}

function resolveKey(cfg: LlmConfig): string {
  const key = cfg.apiKey ?? process.env.UNVIBE_API_KEY ?? '';
  if (!key && cfg.provider !== 'mock') {
    throw new Error(
      `No API key for provider "${cfg.provider}". Pass --api-key or set UNVIBE_API_KEY. ` +
        `Or use --llm-provider mock for deterministic offline codegen.`,
    );
  }
  return key;
}

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LLM request failed (${res.status} ${res.statusText}): ${text.slice(0, 500)}`);
  }
  return res.json() as Promise<unknown>;
}

export class OpenAiCompatibleClient implements LlmClient {
  readonly provider: LlmProvider = 'openai';
  constructor(
    readonly model: string,
    private apiKey: string,
    private baseUrl: string,
    private maxTokens = 4096,
    private temperature = 0.2,
  ) {}
  async complete(messages: LlmMessage[]): Promise<string> {
    const url = `${this.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const data = (await postJson(url, { authorization: `Bearer ${this.apiKey}` }, {
      model: this.model,
      messages,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
    })) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('LLM returned no content');
    return content;
  }
}

export class AnthropicClient implements LlmClient {
  readonly provider: LlmProvider = 'anthropic';
  constructor(
    readonly model: string,
    private apiKey: string,
    private maxTokens = 4096,
    private temperature = 0.2,
  ) {}
  async complete(messages: LlmMessage[]): Promise<string> {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const rest = messages.filter((m) => m.role !== 'system');
    const data = (await postJson('https://api.anthropic.com/v1/messages', {
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
    }, {
      model: this.model,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      ...(system ? { system } : {}),
      messages: rest,
    })) as { content?: { type: string; text?: string }[] };
    const text = data.content?.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
    if (!text) throw new Error('LLM returned no content');
    return text;
  }
}

/**
 * Deterministic mock provider. Renders ORIGINAL React/TS code directly from
 * the spec's behavioral inventory (route components, endpoints, entities).
 * Used by tests, CI, and offline demos. Because its input is spec-only,
 * output can never contain platform bundle text.
 */
export class MockLlmClient implements LlmClient {
  readonly provider: LlmProvider = 'mock';
  readonly model = 'mock-spec-codegen-v1';
  async complete(messages: LlmMessage[]): Promise<string> {
    const user = messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    const m = user.match(/```spec-json\n([\s\S]*?)```/);
    if (!m) {
      return '// mock: no spec payload found in prompt\n';
    }
    const target = this.extractTarget(user);
    try {
      const spec = JSON.parse(m[1]) as {
        kind?: string;
        routes?: { path: string; title?: string; components?: { name: string; kind: string; text?: string }[] }[];
        endpoints?: { id: string; method: string; urlPattern: string }[];
        entities?: { name: string; fields: { name: string; type: string }[] }[];
      };
      return renderFromSpec(spec, target);
    } catch {
      return '// mock: spec payload was not valid JSON\n';
    }
  }
  private extractTarget(user: string): string {
    const t = user.match(/^TARGET-FILE:\s*(\S+)/m);
    return t ? t[1] : 'Component.tsx';
  }
}

function pascal(s: string): string {
  return s.replace(/(^|[-_/ ])(\w)/g, (_, __, c: string) => c.toUpperCase()).replace(/[^A-Za-z0-9]/g, '');
}

/** Deterministic spec→code rendering. Original code, written fresh from behavior. */
function renderFromSpec(
  spec: {
    kind?: string;
    routes?: { path: string; title?: string; components?: { name: string; kind: string; text?: string }[] }[];
    endpoints?: { id: string; method: string; urlPattern: string }[];
    entities?: { name: string; fields: { name: string; type: string }[] }[];
  },
  target: string,
): string {
  const header =
    `/**\n * Generated by Unvibe (mock provider) from the behavioral spec.\n * Original code — written fresh from observed behavior, not copied.\n * Target: ${target}\n */\n`;
  if (spec.kind === 'api-client') {
    const fns = (spec.endpoints ?? [])
      .map((e) => {
        const fn = 'call' + pascal(e.id.replace(/[^a-zA-Z0-9]+/g, '-'));
        return `export async function ${fn}(params: Record<string, string | number> = {}): Promise<unknown> {\n  return apiRequest("${e.method}", "${e.urlPattern}", params);\n}`;
      })
      .join('\n\n');
    return `${header}import { apiRequest } from "./http";\n\n${fns || '// no endpoints observed in spec'}\n`;
  }
  if (spec.kind === 'route-page') {
    const route = (spec.routes ?? [])[0];
    if (!route) return `${header}export default function Page() { return null; }\n`;
    const name = pascal(route.path === '/' ? 'home' : route.path) + 'Page';
    const blocks = (route.components ?? [])
      .map((c) => {
        const cls = c.kind === 'hero' ? 'hero' : c.kind === 'navbar' ? 'navbar' : c.kind;
        // DOM inventory joins observed text samples with " | " — split them back out.
        const segments = (c.text ?? c.name).split(/\s*\|\|?\s*/).map((s) => s.replace(/</g, '&lt;').trim()).filter(Boolean).slice(0, 12);
        const label = c.name.replace(/"/g, '');
        const renderSeg = (inner: string): string => {
          if (c.kind === 'button') return `      <button className="btn">${inner}</button>`;
          if (c.kind === 'heading' || c.kind === 'hero') return `      <h1 className="${cls}">${inner}</h1>`;
          if (c.kind === 'form' || c.kind === 'input') return `      <form className="${cls}" onSubmit={(e) => e.preventDefault()}><input placeholder="${inner}" /></form>`;
          if (c.kind === 'navbar') return `      <span className="nav-link">${inner}</span>`;
          return `      <p>${inner}</p>`;
        };
        const inner = segments.map(renderSeg).join('\n');
        return `      <section className="${cls}" aria-label="${label}">\n${inner}\n      </section>`;
      })
      .join('\n');
    return `${header}export default function ${name}() {\n  return (\n    <main>\n${blocks || '      <p>Empty page</p>'}\n    </main>\n  );\n}\n`;
  }
  if (spec.kind === 'entity-types') {
    const types = (spec.entities ?? [])
      .map((e) => {
        const fields = e.fields.map((f) => `  ${f.name}: ${f.type === 'number' ? 'number' : f.type === 'boolean' ? 'boolean' : f.type === 'date' ? 'string' : 'string'};`).join('\n');
        return `export interface ${pascal(e.name)} {\n${fields}\n}`;
      })
      .join('\n\n');
    return `${header}${types || '// no entities observed in spec'}\n`;
  }
  return `${header}// mock provider: unknown target kind\n`;
}

export function createLlmClient(cfg: LlmConfig): LlmClient {
  switch (cfg.provider) {
    case 'mock':
      return new MockLlmClient();
    case 'anthropic':
      return new AnthropicClient(cfg.model, resolveKey(cfg), cfg.maxTokens, cfg.temperature);
    case 'openai':
    default:
      return new OpenAiCompatibleClient(
        cfg.model,
        resolveKey(cfg),
        cfg.baseUrl ?? process.env.UNVIBE_BASE_URL ?? 'https://api.openai.com/v1',
        cfg.maxTokens,
        cfg.temperature,
      );
  }
}
