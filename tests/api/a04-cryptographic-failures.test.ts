import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { buildApp } from '../../apps/api/src/app';
import { protectPassport, revealPassport } from '../../apps/api/src/security';

const key = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const demoPassport = 'FR-DEMO-BRUNO-8742';
const account = { id: '10000000-0000-4000-8000-000000000001', email: 'alice.martin@example.test', full_name: 'Alice Martin', role: 'customer' };
const opened: Array<Awaited<ReturnType<typeof buildApp>>> = [];
afterEach(async () => { await Promise.all(opened.splice(0).map(app => app.close())); });

/** Flips the first byte of a base64 value so authenticated decryption must fail. */
function tamper(value: string): string {
  const bytes = Buffer.from(value, 'base64');
  bytes[0] ^= 0xff;
  return bytes.toString('base64');
}

describe('A04 — Passport Panic', () => {
  it('encrypts passports with AES-GCM instead of reversible encoding', () => {
    const protectedValue = protectPassport(demoPassport, key);
    expect(protectedValue.iv).not.toBe('legacy-base64');
    expect(protectedValue.tag).toBeTruthy();
    expect(protectedValue.ciphertext).not.toContain(demoPassport);
    expect(Buffer.from(protectedValue.ciphertext, 'base64').toString('utf8')).not.toBe(demoPassport);
    expect(revealPassport(protectedValue.ciphertext, protectedValue.iv, protectedValue.tag, key)).toBe(demoPassport);
  });

  it('rejects a modified ciphertext or authentication tag', () => {
    const { ciphertext, iv, tag } = protectPassport(demoPassport, key);
    expect(() => revealPassport(tamper(ciphertext), iv, tag, key)).toThrow();
    expect(() => revealPassport(ciphertext, iv, tamper(tag), key)).toThrow();
  });

  it('refuses legacy base64 rows', () => {
    const legacy = Buffer.from(demoPassport, 'utf8').toString('base64');
    expect(() => revealPassport(legacy, 'legacy-base64', null, key)).toThrow();
  });

  it('no longer exposes the claim route', async () => {
    const pool = {
      query: vi.fn(async (sql: string) => sql.includes('FROM sessions') ? { rowCount: 1, rows: [account] } : Promise.reject(new Error(`Unexpected query: ${sql}`))),
      end: vi.fn(async () => undefined)
    };
    const app = await buildApp(pool as unknown as Pool, { serveFrontend: false });
    opened.push(app);
    const response = await app.inject({
      method: 'POST', url: '/api/challenges/a04/claim', headers: { authorization: 'Bearer alice' }, payload: { passportNumber: demoPassport }
    });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('FLAG{');
  });

  it('stores the passport encrypted and restores it on read', async () => {
    let storedParams: unknown[] = [];
    const pool = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.includes('FROM sessions')) return { rowCount: 1, rows: [account] };
        if (sql.includes('INSERT INTO traveler_profiles')) {
          storedParams = params;
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes('INSERT INTO audit_events')) return { rowCount: 1, rows: [] };
        if (sql.includes('FROM traveler_profiles')) {
          const [, phone, birthDate, nationality, ciphertext, iv, tag] = storedParams;
          return { rowCount: 1, rows: [{ phone, birth_date: birthDate, nationality, passport_ciphertext: ciphertext, passport_iv: iv, passport_tag: tag }] };
        }
        return Promise.reject(new Error(`Unexpected query: ${sql}`));
      }),
      end: vi.fn(async () => undefined)
    };
    const app = await buildApp(pool as unknown as Pool, { serveFrontend: false });
    opened.push(app);
    const headers = { authorization: 'Bearer alice' };

    const update = await app.inject({
      method: 'PUT', url: '/api/me', headers,
      payload: { phone: '+33 6 00 00 00 01', birthDate: '1991-04-12', nationality: 'Française', passportNumber: 'FR00DEMO123' }
    });
    expect(update.statusCode).toBe(200);
    const [, , , , ciphertext, iv, tag] = storedParams as string[];
    expect(ciphertext).not.toContain('FR00DEMO123');
    expect(iv).not.toBe('legacy-base64');
    expect(tag).toBeTruthy();

    const read = await app.inject({ method: 'GET', url: '/api/me', headers });
    expect(read.statusCode).toBe(200);
    expect(read.json().profile.passportNumber).toBe('FR00DEMO123');
  });
});
