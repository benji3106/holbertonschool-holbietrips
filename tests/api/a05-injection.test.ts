import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { buildApp } from '../../apps/api/src/app';

const opened: Array<Awaited<ReturnType<typeof buildApp>>> = [];
afterEach(async () => { await Promise.all(opened.splice(0).map(app => app.close())); });

function fakePool() {
  return {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (!sql.includes('FROM trips')) {
        throw new Error(`Unexpected query: ${sql}`);
      }
      const term = typeof params[0] === 'string' ? params[0] : '';
      if (!term.includes('Kyoto')) {
        return { rowCount: 0, rows: [] };
      }
      return {
        rowCount: 1,
        rows: [{
          id: 'kyoto', slug: 'kyoto-saisons', title: 'Kyoto au rythme des saisons',
          destination: 'Kyoto, Japon', description: 'Temples et jardins',
          departure_date: '2027-10-03', return_date: '2027-10-12',
          price_cents: 219900, seats_available: 9, image_key: 'kyoto'
        }]
      };
    }),
    end: vi.fn(async () => undefined)
  };
}

describe('A05 — Search Party Crasher', () => {
  it('binds search input as a parameter instead of concatenating it into the SQL', async () => {
    const pool = fakePool();
    const app = await buildApp(pool as unknown as Pool, { serveFrontend: false });
    opened.push(app);

    const response = await app.inject({
      method: 'GET',
      url: `/api/trips?q=${encodeURIComponent("') OR 1=1 --")}`
    });

    expect(response.statusCode).toBe(200);
    const [sql, params] = pool.query.mock.calls.at(-1)!;
    expect(sql).toContain('$1');
    expect(sql).not.toContain('1=1');
    expect(params[0]).toContain("') OR 1=1 --");
  });

  it('keeps the unpublished demo trip hidden even with an injection payload', async () => {
    const pool = fakePool();
    const app = await buildApp(pool as unknown as Pool, { serveFrontend: false });
    opened.push(app);

    const response = await app.inject({
      method: 'GET',
      url: `/api/trips?q=${encodeURIComponent("') OR 1=1 --")}`
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('FLAG{');
    expect(response.json().trips).toHaveLength(0);
  });

  it('still returns matching published trips for an ordinary search', async () => {
    const pool = fakePool();
    const app = await buildApp(pool as unknown as Pool, { serveFrontend: false });
    opened.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/trips?q=Kyoto' });

    expect(response.statusCode).toBe(200);
    expect(response.json().trips[0].title).toContain('Kyoto');
  });
});
