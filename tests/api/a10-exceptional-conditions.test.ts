import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { buildApp } from '../../apps/api/src/app';

const alice = { id: '10000000-0000-4000-8000-000000000001', email: 'alice.martin@example.test', full_name: 'Alice Martin', role: 'customer' };
const confirmUrl = '/api/bookings/40000000-0000-4000-8000-000000000001/confirm';
const CONFIRM_UPDATE = "UPDATE bookings SET status='confirmed'";

function fakePool(paymentStatus: string | null = null) {
  return { query: vi.fn(async (sql: string) => {
    if (sql.includes('FROM sessions')) return { rowCount: 1, rows: [alice] };
    if (sql.includes('SELECT b.id,b.status')) return { rowCount: 1, rows: [{ id: 'booking', status: 'pending', payment_status: paymentStatus }] };
    if (sql.includes(CONFIRM_UPDATE)) return { rowCount: 1, rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  }), end: vi.fn(async () => undefined) };
}

function confirmUpdates(pool: ReturnType<typeof fakePool>) {
  return pool.query.mock.calls.filter(([sql]) => String(sql).includes(CONFIRM_UPDATE));
}

const opened: Array<Awaited<ReturnType<typeof buildApp>>> = [];
afterEach(async () => { await Promise.all(opened.splice(0).map(app => app.close())); });

describe('A10 — The Emergency Exit Is Open', () => {
  it('fails closed: an unavailable mandatory check never confirms the booking', async () => {
    const pool = fakePool(); const app = await buildApp(pool as unknown as Pool, { serveFrontend: false }); opened.push(app);
    const response = await app.inject({ method: 'POST', url: confirmUrl, headers: { authorization: 'Bearer alice' }, payload: { simulateCheckFailure: true } });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'Vérification temporairement indisponible, veuillez réessayer plus tard' });
    expect(response.body).not.toContain('FLAG{');
    expect(response.body).not.toContain('readiness checker');
    expect(confirmUpdates(pool)).toHaveLength(0);
  });

  it('preserves the normal rejection when payment is missing', async () => {
    const pool = fakePool(); const app = await buildApp(pool as unknown as Pool, { serveFrontend: false }); opened.push(app);
    const response = await app.inject({ method: 'POST', url: confirmUrl, headers: { authorization: 'Bearer alice' }, payload: {} });
    expect(response.statusCode).toBe(409);
    expect(response.body).not.toContain('FLAG{');
    expect(confirmUpdates(pool)).toHaveLength(0);
  });

  it('confirms a pending booking whose payment is approved', async () => {
    const pool = fakePool('approved'); const app = await buildApp(pool as unknown as Pool, { serveFrontend: false }); opened.push(app);
    const response = await app.inject({ method: 'POST', url: confirmUrl, headers: { authorization: 'Bearer alice' }, payload: {} });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'confirmed' });
    expect(confirmUpdates(pool)).toHaveLength(1);
  });
});
