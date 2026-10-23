import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initPostgres, pgCreateDomain, pgGetDomains } from './src/db/postgres.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function testAivenConnection() {
  console.log('====================================================');
  console.log('🐘 TESTING AIVEN POSTGRESQL CLOUD CONNECTION');
  console.log('====================================================\n');

  const connectionString = process.env.DATABASE_URL;
  console.log('▶ Connecting to Aiven Host: pg-2fc937ad-mail-server.b.aivencloud.com:12447...');

  try {
    const pool = await initPostgres(connectionString);
    console.log('  ✅ [SUCCESS] Connected to Aiven Cloud PostgreSQL!');

    // Check existing domains
    let domains = await pgGetDomains(false);
    console.log(`  Found ${domains.length} existing domain(s) in cloud database.`);

    // If wazemtech.com is not yet in cloud DB, seed it!
    if (!domains.some(d => d.name === 'wazemtech.com')) {
      console.log('  ▶ Seeding wazemtech.com into Aiven PostgreSQL...');
      const d = await pgCreateDomain('wazemtech.com');
      console.log(`  ✅ [SUCCESS] Domain wazemtech.com registered in Aiven (ID: ${d.id})`);
    }

    domains = await pgGetDomains(false);
    console.log('\n📊 Aiven Cloud Domains List:');
    console.table(domains);

    await pool.end();
    console.log('\n====================================================');
    console.log('🎉 Aiven PostgreSQL is 100% operational & ready!');
    console.log('====================================================\n');
  } catch (err) {
    console.error('❌ [Aiven Connection Failed]:', err.message);
  }
}

testAivenConnection();
