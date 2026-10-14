/**
 * Unvibe Spec — the product's contract.
 *
 * A versioned, human-inspectable JSON artifact produced by `analyze` and
 * consumed by `regenerate`. It is checked into every output repo so the
 * rebuild is auditable: everything the LLM saw is right there in the spec.
 *
 * The spec describes BEHAVIOR (routes, components, API shapes, data model),
 * never platform source text. The clean-room boundary is enforced by
 * construction: regenerate prompts are built from this schema only.
 */
import { z } from 'zod';

export const SPEC_VERSION = '1.0.0' as const;

/** Recursive JSON value shape used for inferred request/response payloads. */
export const JsonShapeSchema: z.ZodType<JsonShape> = z.lazy(() =>
  z.object({
    type: z.enum(['string', 'number', 'boolean', 'null', 'array', 'object', 'unknown']),
    format: z.string().optional(), // e.g. "uuid", "date-time", "email", "url"
    properties: z.record(z.string(), JsonShapeSchema).optional(),
    required: z.array(z.string()).optional(),
    items: JsonShapeSchema.optional(),
    examples: z.array(z.unknown()).max(3).optional(),
  }),
);
export type JsonShape = {
  type: 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object' | 'unknown';
  format?: string;
  properties?: Record<string, JsonShape>;
  required?: string[];
  items?: JsonShape;
  examples?: unknown[];
};

/** A behavioral UI component observed on a route (from DOM + screenshots). */
export const ComponentSchema = z.object({
  name: z.string().min(1), // human/LLM-assigned display name, e.g. "PricingCards"
  kind: z.enum([
    'navbar', 'hero', 'heading', 'form', 'input', 'button', 'list', 'card',
    'table', 'media', 'footer', 'modal', 'tabs', 'chart', 'other',
  ]),
  text: z.string().max(2000).optional(), // visible text content (truncated)
  count: z.number().int().nonnegative().default(1),
});
export type SpecComponent = z.infer<typeof ComponentSchema>;

export const RouteSchema = z.object({
  path: z.string().min(1),
  title: z.string().optional(),
  screenshot: z.string(), // relative path under the capture dir
  outgoingLinks: z.array(z.string()).default([]),
  components: z.array(ComponentSchema).default([]),
  apiCalls: z.array(z.string()).default([]), // endpoint ids observed on this route
});
export type SpecRoute = z.infer<typeof RouteSchema>;

export const EndpointSchema = z.object({
  id: z.string().min(1),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']),
  url: z.string().min(1), // original absolute URL as observed
  urlPattern: z.string().min(1), // normalized: ids → :param
  origin: z.enum(['har', 'bundle', 'inferred']),
  requestShape: JsonShapeSchema.optional(),
  responseShape: JsonShapeSchema.optional(),
  sampleCount: z.number().int().nonnegative().default(1),
  routes: z.array(z.string()).default([]), // route paths where observed
});
export type SpecEndpoint = z.infer<typeof EndpointSchema>;

export const FieldSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['string', 'number', 'boolean', 'date', 'json', 'uuid']),
  nullable: z.boolean().default(false),
  examples: z.array(z.unknown()).max(2).optional(),
});
export type SpecField = z.infer<typeof FieldSchema>;

export const EntitySchema = z.object({
  name: z.string().min(1), // PascalCase, inferred
  tableName: z.string().min(1), // snake_case
  fields: z.array(FieldSchema).min(1),
  /** Where the entity was observed. Entities are ONLY created from observed payloads. */
  source: z.enum(['har-payload', 'bundle-string']),
  evidence: z.array(z.string()).default([]), // e.g. "GET /api/projects → response[0]"
});
export type SpecEntity = z.infer<typeof EntitySchema>;

export const AssetSchema = z.object({
  url: z.string().min(1),
  localPath: z.string(), // relative path under capture dir
  kind: z.enum(['script', 'style', 'image', 'font', 'video', 'other']),
  bytes: z.number().int().nonnegative(),
});
export type SpecAsset = z.infer<typeof AssetSchema>;

export const AuthSchema = z.object({
  provider: z.enum(['supabase', 'clerk', 'firebase', 'auth0', 'none', 'unknown']),
  evidence: z.array(z.string()).default([]),
  /** Client config with secrets REDACTED (keys replaced with ***REDACTED***). */
  clientConfig: z.record(z.string(), z.string()).optional(),
});
export type SpecAuth = z.infer<typeof AuthSchema>;

export const ThirdPartySchema = z.object({
  name: z.string().min(1),
  category: z.enum(['analytics', 'payments', 'error-tracking', 'email', 'maps', 'other']),
  evidence: z.array(z.string()).default([]),
});
export type SpecThirdParty = z.infer<typeof ThirdPartySchema>;

/**
 * Something the rebuild could NOT recover. Honest partial recovery:
 * every unrecoverable item MUST be listed here — never silently invented.
 */
export const GapSchema = z.object({
  category: z.enum([
    'rls-policy', 'edge-function', 'database-trigger', 'storage-bucket',
    'auth-config', 'payment-flow', 'secret', 'cron-job', 'realtime-subscription', 'other',
  ]),
  title: z.string().min(1),
  description: z.string().min(1),
  manualSteps: z.array(z.string().min(1)).min(1),
  recoverable: z.literal(false),
});
export type SpecGap = z.infer<typeof GapSchema>;

export const UnvibeSpecSchema = z.object({
  specVersion: z.literal(SPEC_VERSION),
  source: z.object({
    platform: z.literal('lovable'),
    url: z.string().url(),
    capturedAt: z.string(), // ISO-8601
    unvibeVersion: z.string(),
  }),
  ownership: z.object({
    attestedAt: z.string(), // ISO-8601
    method: z.enum(['flag', 'prompt']),
  }),
  routes: z.array(RouteSchema).min(1),
  endpoints: z.array(EndpointSchema).default([]),
  entities: z.array(EntitySchema).default([]),
  assets: z.array(AssetSchema).default([]),
  auth: AuthSchema,
  thirdParty: z.array(ThirdPartySchema).default([]),
  gaps: z.array(GapSchema).default([]),
  stats: z.object({
    pagesVisited: z.number().int().nonnegative(),
    requestsCaptured: z.number().int().nonnegative(),
    scriptsAnalyzed: z.number().int().nonnegative(),
  }),
});
export type UnvibeSpec = z.infer<typeof UnvibeSpecSchema>;

/** Parse and validate an unknown value as an UnvibeSpec. Throws on invalid. */
export function parseSpec(raw: unknown): UnvibeSpec {
  return UnvibeSpecSchema.parse(raw);
}

/** Validate without throwing; returns a list of human-readable issues. */
export function validateSpec(raw: unknown): string[] {
  const r = UnvibeSpecSchema.safeParse(raw);
  if (r.success) return [];
  return r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}
