import { describe, it, expect, afterEach } from 'vitest';
import { enforceOwnershipGate, GateRefusal } from '../src/gate.js';

const URL = 'https://demo.lovable.app';

afterEach(() => {
  delete process.env.UNVIBE_ALLOW_LOCALHOST;
});

describe('ownership gate', () => {
  it('attests via --i-own-this flag', async () => {
    const a = await enforceOwnershipGate({ iOwnThis: true, url: URL });
    expect(a.method).toBe('flag');
    expect(a.attestedAt).toBeTruthy();
  });

  it('refuses when the flag is absent and stdin is not a TTY', async () => {
    await expect(enforceOwnershipGate({ iOwnThis: false, url: URL, tty: false }))
      .rejects.toThrow(GateRefusal);
    await expect(enforceOwnershipGate({ iOwnThis: false, url: URL, tty: false }))
      .rejects.toThrow(/--i-own-this/);
  });

  it('attests via interactive prompt when the user types YES', async () => {
    const a = await enforceOwnershipGate({
      iOwnThis: false, url: URL, tty: true, promptFn: async () => 'YES',
    });
    expect(a.method).toBe('prompt');
  });

  it('refuses when the prompt answer is not an explicit YES', async () => {
    for (const answer of ['no', 'y', '', 'maybe']) {
      await expect(enforceOwnershipGate({
        iOwnThis: false, url: URL, tty: true, promptFn: async () => answer,
      })).rejects.toThrow(/not attested/i);
    }
  });
});

describe('target scope (v1: Lovable only)', () => {
  it('accepts *.lovable.app targets', async () => {
    const a = await enforceOwnershipGate({ iOwnThis: true, url: 'https://my-app.lovable.app/page' });
    expect(a.method).toBe('flag');
  });

  it('refuses non-Lovable hosts', async () => {
    await expect(enforceOwnershipGate({ iOwnThis: true, url: 'https://example.com' }))
      .rejects.toThrow(/lovable\.app/);
  });

  it('refuses lovable.app impostor subdomains', async () => {
    await expect(enforceOwnershipGate({ iOwnThis: true, url: 'https://lovable.app.evil.com' }))
      .rejects.toThrow(GateRefusal);
  });

  it('refuses localhost unless UNVIBE_ALLOW_LOCALHOST=1', async () => {
    await expect(enforceOwnershipGate({ iOwnThis: true, url: 'http://localhost:8901/' }))
      .rejects.toThrow(/localhost/i);
    process.env.UNVIBE_ALLOW_LOCALHOST = '1';
    const a = await enforceOwnershipGate({ iOwnThis: true, url: 'http://localhost:8901/' });
    expect(a.method).toBe('flag');
  });
});

describe('DRM / circumvention refusal', () => {
  it('refuses circumvention-shaped targets', async () => {
    for (const url of [
      'https://x.lovable.app/drm-crack-tool',
      'https://x.lovable.app/keygen-studio',
      'https://x.lovable.app/paywall-bypass',
    ]) {
      await expect(enforceOwnershipGate({ iOwnThis: true, url }))
        .rejects.toThrow(/circumvention/i);
    }
  });

  it('does not refuse ordinary targets', async () => {
    const a = await enforceOwnershipGate({ iOwnThis: true, url: 'https://crm-dashboard.lovable.app' });
    expect(a.method).toBe('flag');
  });
});
