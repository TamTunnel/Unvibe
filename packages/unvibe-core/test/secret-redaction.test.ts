import { describe, it, expect } from 'vitest';
import { inferShape, isSecretShaped, SECRET_KEY_RE } from '../src/analyze.js';

/**
 * B1 regression tests: secret-shaped values must be masked as
 * {redacted: true} — never land in the spec, prompts, or output repo.
 */
describe('SECRET_KEY_RE', () => {
  it('matches the mandated pattern set', () => {
    for (const k of ['api_key', 'session_token', 'client_secret', 'password', 'passwd', 'auth_header', 'access_credential', 'privateKey']) {
      expect(SECRET_KEY_RE.test(k), k).toBe(true);
    }
  });
});

describe('isSecretShaped', () => {
  it('flags secret key names regardless of value', () => {
    expect(isSecretShaped('hello', 'session_token')).toBe(true);
    expect(isSecretShaped('abc', 'password')).toBe(true);
  });
  it('flags known credential formats even under innocent keys', () => {
    expect(isSecretShaped('sk_live_abc123', 'note')).toBe(true);
    expect(isSecretShaped('ghp_abc123def456', 'note')).toBe(true);
    expect(isSecretShaped('AKIAIOSFODNN7EXAMPLE', 'note')).toBe(true);
    expect(isSecretShaped('eyJhbGciOiJIUzI1NiJ9.payload', 'note')).toBe(true);
  });
  it('flags high-entropy random strings', () => {
    expect(isSecretShaped('K7x9Qm2vZ4nP8wL1jH5tG3bN0yR6sDf7uI')).toBe(true);
  });
  it('does not flag structural values', () => {
    expect(isSecretShaped('https://demo.lovable.app/api/projects')).toBe(false);
    expect(isSecretShaped('ada@example.com')).toBe(false);
    expect(isSecretShaped('11111111-1111-4111-8111-111111111111')).toBe(false);
    expect(isSecretShaped('2026-01-05T10:00:00Z')).toBe(false);
    expect(isSecretShaped('Alpha')).toBe(false);
  });
});

describe('inferShape redaction (B1)', () => {
  it('masks values for secret key names', () => {
    const s = inferShape({ name: 'Alpha', session_token: 'sk_test_CANARY_DO_NOT_USE_0000' });
    expect(s.properties?.name).toMatchObject({ examples: ['Alpha'] });
    expect(s.properties?.session_token).toMatchObject({ examples: [{ redacted: true }] });
    expect(JSON.stringify(s)).not.toContain('CANARY');
  });

  it('masks high-entropy secret values in arrays even under innocent keys', () => {
    const s = inferShape({ misc: ['K7x9Qm2vZ4nP8wL1jH5tG3bN0yR6sDf7uI'] });
    expect(s.properties?.misc?.examples).toEqual([{ redacted: true }]);
  });

  it('redacts whole subtrees under secret keys', () => {
    const s = inferShape({ credentials: { username: 'ada', password: 'hunter2' } });
    const creds = s.properties?.credentials;
    expect(creds?.properties?.username?.examples).toEqual([{ redacted: true }]);
    expect(creds?.properties?.password?.examples).toEqual([{ redacted: true }]);
    expect(JSON.stringify(s)).not.toContain('hunter2');
  });

  it('keeps benign examples intact', () => {
    const s = inferShape({ id: '11111111-1111-4111-8111-111111111111', name: 'Alpha', stars: 12 });
    expect(s.properties?.id?.examples).toEqual(['11111111-1111-4111-8111-111111111111']);
    expect(s.properties?.name?.examples).toEqual(['Alpha']);
    expect(s.properties?.stars?.examples).toEqual([12]);
  });
});

describe('inferShape array-of-objects scrubbing', () => {
  it('deep-scrubs secrets inside raw array examples', () => {
    const s = inferShape([
      { id: '11111111-1111-4111-8111-111111111111', name: 'Alpha', session_token: 'sk_test_CANARY_DO_NOT_USE_0000' },
    ]);
    expect(s.type).toBe('array');
    const ex = s.examples?.[0] as Record<string, unknown>;
    expect(ex.name).toBe('Alpha');
    expect(ex.session_token).toEqual({ redacted: true });
    expect(JSON.stringify(s)).not.toContain('CANARY');
  });
});
