import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
process.env.PAYMENT_SIGNING_KEY ??= 'local-demo-payment-signing-key-not-a-real-secret';

import { buildApp } from '../../apps/api/src/app';
import { paymentSignature } from '../../apps/api/src/security';

const BRUNO_ID = '40000000-0000-4000-8000-000000000002';
const AMOUNT = 129900;
const KEY = process.env.PAYMENT_SIGNING_KEY;

function signedBody(overrides: Record<string, unknown> = {}) {
  const fields = {
    bookingId: BRUNO_ID,
    amountCents: AMOUNT,
    status: 'approved',
    providerReference: 'DEMO-REF-12345',
    cardLast4: '4242'
  };
  const signature = paymentSignature(fields, KEY);
  return { ...fields, ...overrides, signature };
}

function fakePool({ confirmable = true, amount = AMOUNT } = {}) {
  const client = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("UPDATE bookings SET status='confirmed'")) {
        return { rowCount: confirmable ? 1 : 0, rows: [] };
      }
      return { rowCount: 1, rows: [] };
    }),
    release: vi.fn()
  };
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[]) =>
      sql.includes('SELECT id,total_cents FROM bookings') && params[1] === amount && confirmable
        ? { rowCount: 1, rows: [{ id: params[0], total_cents: amount }] }
        : { rowCount: 0, rows: [] }
    ),
    connect: vi.fn(async () => client),
    end: vi.fn(async () => undefined)
  };
  return { pool, client };
}

const opened: Array<Awaited<ReturnType<typeof buildApp>>> = [];
afterEach(async () => { await Promise.all(opened.splice(0).map(app => app.close())); });

async function appWith(options?: Parameters<typeof fakePool>[0]) {
  const fake = fakePool(options);
  const app = await buildApp(fake.pool as unknown as Pool, { serveFrontend: false });
  opened.push(app);
  return { app, fake };
}

describe('A08 — Payment Postcard Pretender', () => {
  it('confirms a booking when the callback is correctly signed', async () => {
    const { app } = await appWith();
    const response = await app.inject({
      method: 'POST', url: '/api/payments/callback', payload: signedBody()
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('confirmed');
    expect(response.json().flag).toMatch(/^FLAG\{a08_[a-f0-9]{24}\}$/);
  });
  it('rejects an unsigned callback', async () => {
    const { app, fake } = await appWith();
    const { signature, ...unsigned } = signedBody();
    const response = await app.inject({
      method: 'POST', url: '/api/payments/callback', payload: unsigned
    });
    expect(response.statusCode).toBe(401);
    expect(fake.pool.connect).not.toHaveBeenCalled();
  });

  it('rejects a callback whose amount was tampered with after signing', async () => {
    const { app } = await appWith({ amount: 1 });
    const response = await app.inject({
      method: 'POST', url: '/api/payments/callback',
      payload: signedBody({ amountCents: 1 })
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a signed callback that does not match the booking amount', async () => {
    const { app } = await appWith({ amount: AMOUNT });
    const fields = {
      bookingId: BRUNO_ID, amountCents: 999, status: 'approved',
      providerReference: 'DEMO-REF-12345', cardLast4: '4242'
    };
    const response = await app.inject({
      method: 'POST', url: '/api/payments/callback',
      payload: { ...fields, signature: paymentSignature(fields, KEY) }
    });
    expect(response.statusCode).toBe(404);
  });

  it('rejects a replayed callback on an already-confirmed booking', async () => {
    const { app } = await appWith({ confirmable: false });
    const response = await app.inject({
      method: 'POST', url: '/api/payments/callback', payload: signedBody()
    });
    expect([404, 409]).toContain(response.statusCode);
  });
});
