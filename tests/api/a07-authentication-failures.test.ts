import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { buildApp } from '../../apps/api/src/app';
import { internalJson, legacyResetToken, newToken } from '../../apps/api/src/security';

vi.mock('../../apps/api/src/security', async importOriginal => {
  const actual = await importOriginal<typeof import('../../apps/api/src/security')>();
  return { ...actual, internalJson: vi.fn(async () => ({})) };
});

const opened: Array<Awaited<ReturnType<typeof buildApp>>> = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map(app => app.close()));
  vi.mocked(internalJson).mockClear();
});

const BRUNO = { id: '10000000-0000-4000-8000-000000000002', email: 'bruno.dupont@example.test' };

type TokenRecord = { userId: string; expiresAt: number; usedAt: number | null };

function fakePool() {
  const tokens = new Map<string, TokenRecord>();

  function handle(sql: string, params: unknown[] = []) {
    if (sql.includes('FROM users WHERE email=$1')) {
      const email = params[0] as string;
      return email === BRUNO.email
        ? { rowCount: 1, rows: [{ id: BRUNO.id, email: BRUNO.email }] }
        : { rowCount: 0, rows: [] };
    }
    if (sql.includes('INSERT INTO password_reset_tokens')) {
      const [tokenHash, userId] = params as [string, string];
      tokens.set(tokenHash, { userId, expiresAt: Date.now() + 15 * 60_000, usedAt: null });
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes('SELECT user_id FROM password_reset_tokens')) {
      const entry = tokens.get(params[0] as string);
      const valid = !!entry && entry.expiresAt > Date.now() && entry.usedAt === null;
      return valid ? { rowCount: 1, rows: [{ user_id: entry!.userId }] } : { rowCount: 0, rows: [] };
    }
    if (sql.includes('UPDATE password_reset_tokens SET used_at')) {
      const entry = tokens.get(params[0] as string);
      if (entry) entry.usedAt = Date.now();
      return { rowCount: entry ? 1 : 0, rows: [] };
    }
    if (sql.includes('UPDATE users SET password_hash')) return { rowCount: 1, rows: [] };
    if (sql.includes('DELETE FROM sessions')) return { rowCount: 0, rows: [] };
    if (sql.startsWith('BEGIN') || sql.startsWith('COMMIT') || sql.startsWith('ROLLBACK')) {
      return { rowCount: 0, rows: [] };
    }
    return { rowCount: 1, rows: [] }; // audit log, etc.
  }

  const client = { query: vi.fn(async (sql: string, params?: unknown[]) => handle(sql, params)), release: vi.fn() };
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => handle(sql, params)),
    connect: vi.fn(async () => client),
    end: vi.fn(async () => undefined),
    __tokens: tokens
  };
}

async function requestReset(app: Awaited<ReturnType<typeof buildApp>>) {
  await app.inject({
    method: 'POST',
    url: '/api/auth/password-reset/request',
    payload: { email: BRUNO.email }
  });
  const lastCall = vi.mocked(internalJson).mock.calls.at(-1)!;
  const body = JSON.parse((lastCall[2] as { body: string }).body);
  return body.resetToken as string;
}

describe('A07 — Reset Route Roulette', () => {
  it('characterizes the flaw: a reset token is predictable from the e-mail address', () => {
    const first = legacyResetToken('bruno.dupont@example.test');
    const second = legacyResetToken('bruno.dupont@example.test');
    expect(first).toBe(second);
    expect(Buffer.from(first, 'base64url').toString('utf8')).toBe('bruno.dupont@example.test');
  });

  it('documents the expected positive property of a secure token', () => {
    expect(newToken()).not.toBe(newToken());
  });

  it('completes a legitimate password reset end to end', async () => {
    const pool = fakePool();
    const app = await buildApp(pool as unknown as Pool, { serveFrontend: false });
    opened.push(app);

    const token = await requestReset(app);

    const confirm = await app.inject({
      method: 'POST',
      url: '/api/auth/password-reset/confirm',
      payload: { token, password: 'NouveauMotDePasse123!' }
    });

    expect(confirm.statusCode).toBe(200);
    expect(confirm.json()).toEqual({ ok: true });
  });

  it('rejects a token predicted from the e-mail address alone', async () => {
    const pool = fakePool();
    const app = await buildApp(pool as unknown as Pool, { serveFrontend: false });
    opened.push(app);

    await requestReset(app); // a legitimate (random) token now exists for Bruno

    const guessed = legacyResetToken(BRUNO.email);
    const confirm = await app.inject({
      method: 'POST',
      url: '/api/auth/password-reset/confirm',
      payload: { token: guessed, password: 'NouveauMotDePasse123!' }
    });

    expect(confirm.statusCode).toBe(400);
    expect(confirm.body).not.toContain('FLAG{');
  });

  it('rejects an expired token', async () => {
    const pool = fakePool();
    const app = await buildApp(pool as unknown as Pool, { serveFrontend: false });
    opened.push(app);

    const token = await requestReset(app);
    for (const entry of pool.__tokens.values()) entry.expiresAt = Date.now() - 1000;

    const confirm = await app.inject({
      method: 'POST',
      url: '/api/auth/password-reset/confirm',
      payload: { token, password: 'NouveauMotDePasse123!' }
    });

    expect(confirm.statusCode).toBe(400);
  });

  it('rejects a token that has already been used once', async () => {
    const pool = fakePool();
    const app = await buildApp(pool as unknown as Pool, { serveFrontend: false });
    opened.push(app);

    const token = await requestReset(app);
    const first = await app.inject({
      method: 'POST',
      url: '/api/auth/password-reset/confirm',
      payload: { token, password: 'NouveauMotDePasse123!' }
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: '/api/auth/password-reset/confirm',
      payload: { token, password: 'EncoreUnAutreMdp123!' }
    });

    expect(second.statusCode).toBe(400);
  });
});
