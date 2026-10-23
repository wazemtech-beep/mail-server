import 'dotenv/config';
import app from '../src/server.js';
import { initPostgres, getPgPool } from '../src/db/postgres.js';

if (process.env.DATABASE_URL && !getPgPool()) {
  try {
    await initPostgres(process.env.DATABASE_URL);
  } catch (err) {
    console.error('❌ [Vercel Aiven PostgreSQL Error]:', err.message);
  }
}

export default app;
