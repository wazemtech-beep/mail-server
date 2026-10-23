import 'dotenv/config';
import { db } from './src/db/database.js';
import { initPostgres, getPgPool } from './src/db/postgres.js';

async function migrateSqliteToPostgres() {
  console.log('====================================================');
  console.log('🔄 MIGRATING SQLITE DATA TO AIVEN POSTGRESQL');
  console.log('====================================================\n');

  const pool = await initPostgres(process.env.DATABASE_URL);
  const client = await pool.connect();

  try {
    // 1. Migrate Domains
    const sqliteDomains = db.prepare('SELECT * FROM domains').all();
    console.log(`▶ Found ${sqliteDomains.length} domain(s) in SQLite.`);

    const domainMap = new Map(); // sqliteId -> pgId

    for (const d of sqliteDomains) {
      const existing = await client.query('SELECT * FROM domains WHERE name = $1', [d.name.toLowerCase()]);
      let pgDomainId;

      if (existing.rows.length > 0) {
        pgDomainId = existing.rows[0].id;
        console.log(`  ✓ Domain "${d.name}" already in PostgreSQL (ID: ${pgDomainId})`);
      } else {
        const ins = await client.query(
          `INSERT INTO domains (name, status, dkim_selector, dkim_private_key, dkim_public_key, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id`,
          [d.name.toLowerCase(), d.status || 'active', d.dkim_selector || 'default', d.dkim_private_key, d.dkim_public_key, d.created_at]
        );
        pgDomainId = ins.rows[0].id;
        console.log(`  + Migrated domain "${d.name}" -> PostgreSQL (ID: ${pgDomainId})`);
      }
      domainMap.set(d.id, pgDomainId);
    }

    // 2. Migrate Mailboxes
    const sqliteMailboxes = db.prepare('SELECT * FROM mailboxes').all();
    console.log(`\n▶ Found ${sqliteMailboxes.length} mailbox(es) in SQLite.`);

    const mailboxMap = new Map(); // sqliteId -> pgId

    for (const m of sqliteMailboxes) {
      const targetDomainId = domainMap.get(m.domain_id);
      if (!targetDomainId) continue;

      const existing = await client.query('SELECT * FROM mailboxes WHERE email = $1', [m.email.toLowerCase()]);
      let pgMailboxId;

      if (existing.rows.length > 0) {
        pgMailboxId = existing.rows[0].id;
        console.log(`  ✓ Mailbox "${m.email}" already in PostgreSQL (ID: ${pgMailboxId})`);
      } else {
        const ins = await client.query(
          `INSERT INTO mailboxes (domain_id, email, name, password_hash, quota_mb, api_token, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id`,
          [targetDomainId, m.email.toLowerCase(), m.name, m.password_hash, m.quota_mb || 1024, m.api_token, m.created_at]
        );
        pgMailboxId = ins.rows[0].id;
        console.log(`  + Migrated mailbox "${m.email}" -> PostgreSQL (ID: ${pgMailboxId})`);
      }
      mailboxMap.set(m.id, pgMailboxId);
    }

    // 3. Migrate Emails & Attachments
    const sqliteEmails = db.prepare('SELECT * FROM emails').all();
    console.log(`\n▶ Found ${sqliteEmails.length} email(s) in SQLite.`);

    let emailsMigrated = 0;
    for (const e of sqliteEmails) {
      const targetMailboxId = mailboxMap.get(e.mailbox_id);
      if (!targetMailboxId) continue;

      // Check if email already exists
      const check = await client.query(
        `SELECT id FROM emails WHERE mailbox_id = $1 AND (provider_email_id = $2 OR (message_id = $3 AND subject = $4))`,
        [targetMailboxId, e.provider_email_id || 'none', e.message_id || 'none', e.subject || '']
      );

      if (check.rows.length > 0) {
        continue;
      }

      // Ensure raw_headers is valid JSON for PostgreSQL JSON/JSONB type
      let safeHeaders = '{}';
      if (e.raw_headers) {
        try {
          safeHeaders = typeof e.raw_headers === 'object' ? JSON.stringify(e.raw_headers) : JSON.stringify(JSON.parse(e.raw_headers));
        } catch {
          safeHeaders = JSON.stringify({ raw: String(e.raw_headers) });
        }
      }

      const ins = await client.query(
        `INSERT INTO emails (
          mailbox_id, folder, direction, from_address, from_name,
          to_address, subject, body_text, body_html, raw_headers, message_id,
          dkim_status, delivery_status, provider_email_id, is_read, is_starred, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        RETURNING id`,
        [
          targetMailboxId,
          e.folder,
          e.direction,
          e.from_address,
          e.from_name,
          e.to_address,
          e.subject,
          e.body_text,
          e.body_html,
          safeHeaders,
          e.message_id,
          e.dkim_status,
          e.delivery_status,
          e.provider_email_id,
          e.is_read,
          e.is_starred,
          e.created_at
        ]
      );
      const newEmailId = ins.rows[0].id;
      emailsMigrated++;

      // Migrate any attachments for this email
      const atts = db.prepare('SELECT * FROM attachments WHERE email_id = ?').all(e.id);
      for (const a of atts) {
        await client.query(
          `INSERT INTO attachments (email_id, filename, content_type, size, data_base64, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [newEmailId, a.filename, a.content_type, a.size, a.data_base64, a.created_at]
        );
      }
    }
    console.log(`  + Migrated ${emailsMigrated} new email(s) into PostgreSQL.`);

    console.log('\n====================================================');
    console.log('🎉 SQLite -> Aiven PostgreSQL Migration Complete!');
    console.log('====================================================\n');
  } finally {
    client.release();
    await pool.end();
  }
}

migrateSqliteToPostgres().catch(err => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
