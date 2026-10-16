import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { buildApp } from '../../apps/api/src/app';

const alice = { id: '10000000-0000-4000-8000-000000000001', email: 'alice.martin@example.test', full_name: 'Alice Martin', role: 'customer' };
const bruno = { id: '10000000-0000-4000-8000-000000000002', email: 'bruno.dupont@example.test', full_name: 'Bruno Dupont', role: 'customer' };
const BOOKING_ID = '40000000-0000-4000-8000-000000000001';
const MISSING_ID = '40000000-0000-4000-8000-0000000000ff';
const URL = (id: string) => `/api/bookings/${id}/cancel`;

type Booking = { id: string; reference: string; status: string; user_id: string };
type Audit = { user_id: string | null; action: string; entity_type: string; entity_id: string | null; metadata: Record<string, unknown> };
type State = { bookings: Booking[]; audits: Audit[] };

const aliceBooking = (status = 'confirmed'): Booking => ({ id: BOOKING_ID, reference: 'HT-ALICE-001', status, user_id: alice.id });
const empty = { rowCount: 0, rows: [] as unknown[] };

function fakePool(options: { user?: typeof alice; failAudit?: boolean; bookings?: Booking[] } = {}) {
  const user = options.user ?? alice;
  let committed: State = { bookings: structuredClone(options.bookings ?? [aliceBooking()]), audits: [] };
  const release = vi.fn();

  const connect = vi.fn(async () => {
    let staged: State | null = null;
    return {
      release,
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        if (sql === 'BEGIN') { staged = structuredClone(committed); return empty; }
        if (sql === 'COMMIT') { if (staged) committed = staged; staged = null; return empty; }
        if (sql === 'ROLLBACK') { staged = null; return empty; }

        const work = staged ?? committed;
        if (sql.includes('FROM bookings') && sql.includes('FOR UPDATE')) {
          // Copies, comme avec Postgres : une lecture ne doit pas changer après un UPDATE
          const rows = work.bookings.filter(b => b.id === params[0]).map(b => ({ ...b }));
          return { rowCount: rows.length, rows };
        }
        if (sql.includes("UPDATE bookings SET status='cancelled'")) {
          const booking = work.bookings.find(b => b.id === params[0]);
          if (!booking) return empty;
          booking.status = 'cancelled';
          return { rowCount: 1, rows: [{ id: booking.id, reference: booking.reference, status: booking.status }] };
        }
        if (sql.includes('INSERT INTO audit_events')) {
          if (options.failAudit) throw new Error('audit storage unavailable');
          work.audits.push({
            user_id: params[0] as string | null,
            action: params[1] as string,
            entity_type: params[2] as string,
            entity_id: params[3] as string | null,
            metadata: JSON.parse(String(params[4]))
          });
          return { rowCount: 1, rows: [] };
        }
        throw new Error(`Unexpected client query: ${sql}`);
      })
    };
  });

  const pool = {
    connect,
    query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM sessions')) return { rowCount: 1, rows: [user] };
      throw new Error(`Unexpected pool query: ${sql}`);
    }),
    end: vi.fn(async () => undefined)
  };
  return { pool, release, state: () => committed };
}

const opened: Array<Awaited<ReturnType<typeof buildApp>>> = [];
afterEach(async () => { await Promise.all(opened.splice(0).map(app => app.close())); });

async function cancel(fake: ReturnType<typeof fakePool>, id = BOOKING_ID) {
  const app = await buildApp(fake.pool as unknown as Pool, { serveFrontend: false });
  opened.push(app);
  return app.inject({ method: 'POST', url: URL(id), headers: { authorization: 'Bearer test' } });
}

describe('A09 — The Silent Suitcase', () => {
  describe('owned booking: success is cancelled AND audited', () => {
    it('preserves the customer journey and leaves no flag behind', async () => {
      const fake = fakePool();
      const response = await cancel(fake);
      expect(response.statusCode).toBe(200);
      expect(response.json().booking).toMatchObject({ reference: 'HT-ALICE-001', status: 'cancelled' });
      expect(response.json().flag).toBeUndefined();
      expect(fake.state().bookings[0].status).toBe('cancelled');
    });

    it('records actor, action, target and result without secrets', async () => {
      const fake = fakePool();
      await cancel(fake);
      const events = fake.state().audits;
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        user_id: alice.id,
        action: 'booking.cancelled',
        entity_type: 'booking',
        entity_id: BOOKING_ID,
        metadata: { result: 'success', reference: 'HT-ALICE-001', previousStatus: 'confirmed' }
      });
      expect(JSON.stringify(events[0].metadata)).not.toMatch(/bearer|token|password|authorization|card/i);
    });
  });

  describe('denied attempts: traced, but no business mutation', () => {
    it('refuses another traveller, keeps the booking intact and audits the attempt', async () => {
      const fake = fakePool({ user: bruno });
      const response = await cancel(fake);
      expect(response.statusCode).toBe(404);
      expect(response.json().flag).toBeUndefined();
      expect(fake.state().bookings[0].status).toBe('confirmed');
      expect(fake.state().audits).toEqual([
        expect.objectContaining({
          user_id: bruno.id,
          action: 'booking.cancel.denied',
          entity_id: BOOKING_ID,
          metadata: { result: 'denied', reason: 'not_owner' }
        })
      ]);
    });

    it('audits an unknown booking without revealing anything different to the client', async () => {
      const fake = fakePool();
      const response = await cancel(fake, MISSING_ID);
      expect(response.statusCode).toBe(404);
      expect(fake.state().audits[0]).toMatchObject({
        user_id: alice.id,
        action: 'booking.cancel.denied',
        entity_id: MISSING_ID,
        metadata: { result: 'denied', reason: 'not_found' }
      });
    });

    it('audits a second cancellation and does not change the booking again', async () => {
      const fake = fakePool({ bookings: [aliceBooking('cancelled')] });
      const response = await cancel(fake);
      expect(response.statusCode).toBe(404);
      expect(fake.state().bookings[0].status).toBe('cancelled');
      expect(fake.state().audits[0]).toMatchObject({
        action: 'booking.cancel.denied',
        metadata: { result: 'denied', reason: 'already_cancelled' }
      });
    });

    it('rejects a malformed id without touching the database', async () => {
      const fake = fakePool();
      const response = await cancel(fake, 'not-a-uuid');
      expect(response.statusCode).toBe(400);
      expect(fake.pool.connect).not.toHaveBeenCalled();
      expect(fake.state().bookings[0].status).toBe('confirmed');
    });
  });

  describe('atomicity: no audit, no cancellation', () => {
    it('rolls the cancellation back when the audit write fails', async () => {
      const fake = fakePool({ failAudit: true });
      const response = await cancel(fake);
      expect(response.statusCode).toBeGreaterThanOrEqual(500);
      expect(fake.state().bookings[0].status).toBe('confirmed');
      expect(fake.state().audits).toHaveLength(0);
      expect(fake.release).toHaveBeenCalledTimes(1);
    });
  });
});