import 'dotenv/config';
import app from '../src/server.js';
import { initPostgres, getPgPool } from '../src/db/postgres.js';

// Cold start initialization for Aiven PostgreSQL on Vercel
let initPromise = null;

async function ensureDb() {
  if (process.env.DATABASE_URL && !getPgPool()) {
    if (!initPromise) {
      initPromise = initPostgres(process.env.DATABASE_URL).catch(err => {
        initPromise = null;
        console.error('[Vercel Aiven Connect Error]:', err.message);
      });
    }
    await initPromise;
  }
}

export default async function handler(req, res) {
  await ensureDb();
  return app(req, res);
}
