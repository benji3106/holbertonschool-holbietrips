import { describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { loadDestinationPack } from '../../apps/api/src/destination-pack';
import { buildApp } from '../../apps/api/src/app';
import type { Pool } from 'pg';

const approvedDigest = '78f5ba6c78041a2f7cff89ad032c5df7a5a03c9dddbe63150d7ca2d23be4bc93';

describe('A03 — The Mystery Destination Pack', () => {
  it('rejects an altered pack whose digest does not match the approved one', async () => {
    await expect(
      loadDestinationPack(resolve('database/fixtures/destination-pack-altered.json'), approvedDigest)
    ).rejects.toThrow();
  });

  it('keeps serving the approved pack without any flag', async () => {
    const pool = { query: vi.fn(async () => ({ rows: [] })), end: vi.fn(async () => undefined) };
    const app = await buildApp(pool as unknown as Pool, { serveFrontend: false, diagnosticsEnabled: false });

    const pack = await app.inject({ method: 'GET', url: '/api/destination-pack' });
    expect(pack.statusCode).toBe(200);
    expect(pack.body).not.toContain('FLAG{');

    const trips = await app.inject({ method: 'GET', url: '/api/trips' });
    expect(trips.statusCode).toBe(200);
    expect(trips.body).not.toContain('FLAG{');

    await app.close();
  });
});
