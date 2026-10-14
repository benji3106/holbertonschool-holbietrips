import { Pool } from 'pg';
import { encryptSensitive } from '../apps/api/src/security';

const keyHex = process.env.APP_ENCRYPTION_KEY;
const databaseUrl = process.env.DATABASE_URL;
if (!keyHex) throw new Error('Configuration manquante: APP_ENCRYPTION_KEY');
if (!databaseUrl) throw new Error('Configuration manquante: DATABASE_URL');

/** Re-encrypts passports still stored as legacy base64; safe to run more than once. */
async function migrate(): Promise<number> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const legacy = await pool.query<{ user_id: string; passport_ciphertext: string }>(
      `SELECT user_id, passport_ciphertext FROM traveler_profiles
       WHERE passport_iv = 'legacy-base64' AND passport_ciphertext IS NOT NULL`
    );
    let migrated = 0;
    for (const row of legacy.rows) {
      const clear = Buffer.from(row.passport_ciphertext, 'base64').toString('utf8');
      const protectedValue = encryptSensitive(clear, keyHex!);
      const result = await pool.query(
        `UPDATE traveler_profiles
         SET passport_ciphertext=$1, passport_iv=$2, passport_tag=$3, updated_at=now()
         WHERE user_id=$4 AND passport_iv='legacy-base64'`,
        [protectedValue.ciphertext, protectedValue.iv, protectedValue.tag, row.user_id]
      );
      migrated += result.rowCount ?? 0;
    }
    return migrated;
  } finally {
    await pool.end();
  }
}

migrate()
  .then(count => console.log(`Passeports migrés: ${count}`))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
