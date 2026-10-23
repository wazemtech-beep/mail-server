import pg from 'pg';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateDkimKeys, hashPassword, verifyPassword } from './database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const caCandidates = [
  path.resolve(process.cwd(), 'ca.pem'),
  path.resolve(__dirname, '../../ca.pem'),
  path.resolve(__dirname, '../ca.pem'),
  path.resolve('/var/task/ca.pem')
];

let caContent = null;
for (const p of caCandidates) {
  if (fs.existsSync(p)) {
    try {
      caContent = fs.readFileSync(p, 'utf8');
      break;
    } catch {}
  }
}

const { Pool } = pg;

let pool = null;

export function getPgPool() {
  return pool;
}

/**
 * Initializes Aiven PostgreSQL connection and runs database migrations
 */
export async function initPostgres(connectionString) {
  let sslConfig = { rejectUnauthorized: false };
  if (caContent) {
    sslConfig = {
      ca: caContent,
      rejectUnauthorized: false
    };
  }

  // Strip sslmode from URL to avoid pg library internal overrides
  const cleanUrl = connectionString ? connectionString.split('?')[0] : '';

  pool = new Pool({
    connectionString: cleanUrl,
    ssl: sslConfig,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });

  // Test Connection
  const client = await pool.connect();
  try {
    console.log('🐘 [Aiven PostgreSQL]: Connected successfully.');

    // Run PostgreSQL Schema Migrations
    await client.query(`
      CREATE TABLE IF NOT EXISTS domains (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        status VARCHAR(50) DEFAULT 'active',
        dkim_selector VARCHAR(50) DEFAULT 'default',
        dkim_private_key TEXT NOT NULL,
        dkim_public_key TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS mailboxes (
        id SERIAL PRIMARY KEY,
        domain_id INTEGER REFERENCES domains(id) ON DELETE CASCADE,
        email VARCHAR(255) UNIQUE NOT NULL,
        name VARCHAR(255) NOT NULL,
        password_hash TEXT NOT NULL,
        quota_mb INTEGER DEFAULT 1024,
        api_token VARCHAR(255) UNIQUE NOT NULL,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS emails (
        id SERIAL PRIMARY KEY,
        mailbox_id INTEGER REFERENCES mailboxes(id) ON DELETE CASCADE,
        folder VARCHAR(50) DEFAULT 'inbox',
        direction VARCHAR(50) DEFAULT 'inbound',
        from_address VARCHAR(255) NOT NULL,
        from_name VARCHAR(255),
        to_address VARCHAR(255) NOT NULL,
        subject TEXT,
        body_text TEXT,
        body_html TEXT,
        is_read INTEGER DEFAULT 0,
        is_starred INTEGER DEFAULT 0,
        raw_headers JSONB,
        message_id VARCHAR(500),
        dkim_status VARCHAR(50) DEFAULT 'none',
        delivery_status VARCHAR(50) DEFAULT 'delivered',
        provider_email_id VARCHAR(255),
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS attachments (
        id SERIAL PRIMARY KEY,
        email_id INTEGER REFERENCES emails(id) ON DELETE CASCADE,
        filename VARCHAR(255) NOT NULL,
        content_type VARCHAR(100),
        size INTEGER,
        data_base64 TEXT,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS outbound_queue (
        id SERIAL PRIMARY KEY,
        mailbox_id INTEGER REFERENCES mailboxes(id) ON DELETE CASCADE,
        to_address VARCHAR(255) NOT NULL,
        subject TEXT,
        status VARCHAR(50) DEFAULT 'pending',
        attempts INTEGER DEFAULT 0,
        max_attempts INTEGER DEFAULT 5,
        last_error TEXT,
        mx_host VARCHAR(255),
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS inbound_events (
        id SERIAL PRIMARY KEY,
        event_id VARCHAR(255) UNIQUE NOT NULL,
        event_type VARCHAR(100) NOT NULL,
        payload JSONB NOT NULL,
        status VARCHAR(50) DEFAULT 'pending',
        attempts INTEGER DEFAULT 0,
        max_attempts INTEGER DEFAULT 5,
        last_error TEXT,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        processed_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS smtp_logs (
        id SERIAL PRIMARY KEY,
        type VARCHAR(50),
        client_ip VARCHAR(50),
        sender VARCHAR(255),
        recipient VARCHAR(255),
        status VARCHAR(50),
        details TEXT,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_pg_emails_provider_mailbox ON emails(provider_email_id, mailbox_id);
      CREATE INDEX IF NOT EXISTS idx_pg_inbound_events_status ON inbound_events(status);
    `);

    console.log('🐘 [Aiven PostgreSQL]: Schema migrations verified.');
  } finally {
    client.release();
  }

  return pool;
}

// ============================================================================
// POSTGRESQL CRUD OPERATIONS (Async)
// ============================================================================

export async function pgCreateDomain(name) {
  const normalized = name.trim().toLowerCase();
  const { privateKey, publicKey } = generateDkimKeys();
  const res = await pool.query(
    `INSERT INTO domains (name, status, dkim_selector, dkim_private_key, dkim_public_key)
     VALUES ($1, 'active', 'default', $2, $3)
     RETURNING id, name, status, dkim_selector, dkim_public_key, created_at`,
    [normalized, privateKey, publicKey]
  );
  return res.rows[0];
}

export async function pgGetDomains(includePrivateKeys = false) {
  const fields = includePrivateKeys
    ? `d.*`
    : `d.id, d.name, d.status, d.dkim_selector, d.dkim_public_key, d.created_at`;
  const res = await pool.query(`
    SELECT ${fields},
      (SELECT COUNT(*)::int FROM mailboxes WHERE domain_id = d.id) as mailbox_count
    FROM domains d
    ORDER BY d.created_at DESC
  `);
  return res.rows;
}

export async function pgGetDomainById(id, includePrivateKeys = false) {
  const fields = includePrivateKeys
    ? `*`
    : `id, name, status, dkim_selector, dkim_public_key, created_at`;
  const res = await pool.query(`SELECT ${fields} FROM domains WHERE id = $1`, [id]);
  return res.rows[0] || null;
}

export async function pgCreateMailbox(domainId, email, name, plainPassword) {
  const normalizedEmail = email.trim().toLowerCase();
  const domain = await pgGetDomainById(domainId, false);
  if (!domain) throw new Error('Target domain does not exist');

  const passwordHash = hashPassword(plainPassword);
  const apiToken = crypto.randomBytes(32).toString('hex');

  const res = await pool.query(
    `INSERT INTO mailboxes (domain_id, email, name, password_hash, api_token)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, domain_id, email, name, quota_mb, api_token, created_at`,
    [domainId, normalizedEmail, name.trim(), passwordHash, apiToken]
  );
  return res.rows[0];
}

export async function pgGetMailboxes(domainId = null, includeSecrets = false) {
  const fields = includeSecrets
    ? `m.*, d.name as domain_name`
    : `m.id, m.domain_id, m.email, m.name, m.quota_mb, m.api_token, m.created_at, d.name as domain_name`;

  let query = `
    SELECT ${fields},
      (SELECT COUNT(*)::int FROM emails WHERE mailbox_id = m.id AND is_read = 0 AND folder = 'inbox') as unread_count
    FROM mailboxes m
    JOIN domains d ON m.domain_id = d.id
  `;
  const params = [];
  if (domainId) {
    query += ` WHERE m.domain_id = $1`;
    params.push(domainId);
  }
  query += ` ORDER BY m.created_at ASC`;

  const res = await pool.query(query, params);
  return res.rows;
}

export async function pgGetMailboxByEmail(email, includeSecrets = false) {
  if (!email) return null;
  const normalized = email.trim().toLowerCase();
  const res = await pool.query(
    `SELECT m.*, d.name as domain_name, d.dkim_private_key, d.dkim_selector
     FROM mailboxes m
     JOIN domains d ON m.domain_id = d.id
     WHERE m.email = $1`,
    [normalized]
  );
  const mailbox = res.rows[0];
  if (!mailbox) return null;
  if (!includeSecrets) {
    delete mailbox.password_hash;
    delete mailbox.dkim_private_key;
  }
  return mailbox;
}

export async function pgGetMailboxById(id, includeSecrets = false) {
  const res = await pool.query(
    `SELECT m.*, d.name as domain_name, d.dkim_private_key, d.dkim_selector
     FROM mailboxes m
     JOIN domains d ON m.domain_id = d.id
     WHERE m.id = $1`,
    [id]
  );
  const mailbox = res.rows[0];
  if (!mailbox) return null;
  if (!includeSecrets) {
    delete mailbox.password_hash;
    delete mailbox.dkim_private_key;
  }
  return mailbox;
}

export async function pgSaveEmail({
  mailboxId,
  folder = 'inbox',
  direction = 'inbound',
  fromAddress,
  fromName,
  toAddress,
  subject,
  bodyText,
  bodyHtml,
  rawHeaders,
  messageId,
  dkimStatus = 'none',
  deliveryStatus = 'delivered',
  providerEmailId = null,
  attachments = []
}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Idempotency check
    if (providerEmailId) {
      const existing = await client.query(
        `SELECT id FROM emails WHERE provider_email_id = $1 AND mailbox_id = $2`,
        [providerEmailId, mailboxId]
      );
      if (existing.rows.length > 0) {
        await client.query('COMMIT');
        return await pgGetEmailById(existing.rows[0].id, mailboxId);
      }
    }

    const emailRes = await client.query(
      `INSERT INTO emails (
        mailbox_id, folder, direction, from_address, from_name,
        to_address, subject, body_text, body_html, raw_headers, message_id,
        dkim_status, delivery_status, provider_email_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING id`,
      [
        mailboxId,
        folder,
        direction,
        fromAddress,
        fromName || '',
        toAddress,
        subject || '(No Subject)',
        bodyText || '',
        bodyHtml || '',
        typeof rawHeaders === 'object' ? JSON.stringify(rawHeaders) : (rawHeaders || '{}'),
        messageId || '',
        dkimStatus,
        deliveryStatus,
        providerEmailId
      ]
    );

    const emailId = emailRes.rows[0].id;

    if (attachments && attachments.length > 0) {
      for (const att of attachments) {
        await client.query(
          `INSERT INTO attachments (email_id, filename, content_type, size, data_base64)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            emailId,
            att.filename || 'attachment.bin',
            att.contentType || att.content_type || 'application/octet-stream',
            att.size || 0,
            att.data_base64 || ''
          ]
        );
      }
    }

    await client.query('COMMIT');
    return await pgGetEmailById(emailId, mailboxId);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function pgGetEmails(mailboxId, folder = 'inbox') {
  const res = await pool.query(
    `SELECT e.*,
       (SELECT COUNT(*)::int FROM attachments WHERE email_id = e.id) as attachment_count
     FROM emails e
     WHERE e.mailbox_id = $1 AND e.folder = $2
     ORDER BY e.created_at DESC`,
    [mailboxId, folder]
  );
  return res.rows;
}

export async function pgGetEmailById(emailId, mailboxId = null) {
  let res;
  if (mailboxId) {
    res = await pool.query(`SELECT * FROM emails WHERE id = $1 AND mailbox_id = $2`, [emailId, mailboxId]);
  } else {
    res = await pool.query(`SELECT * FROM emails WHERE id = $1`, [emailId]);
  }
  const email = res.rows[0];
  if (!email) return null;

  const attRes = await pool.query(`SELECT * FROM attachments WHERE email_id = $1`, [emailId]);
  email.attachments = attRes.rows;
  return email;
}

export async function pgGetAttachmentById(attachmentId, mailboxId) {
  const res = await pool.query(
    `SELECT a.*, e.mailbox_id 
     FROM attachments a
     JOIN emails e ON a.email_id = e.id
     WHERE a.id = $1 AND e.mailbox_id = $2`,
    [attachmentId, mailboxId]
  );
  return res.rows[0] || null;
}

export async function pgMarkEmailRead(id, mailboxId, isRead = 1) {
  const res = await pool.query(
    `UPDATE emails SET is_read = $1 WHERE id = $2 AND mailbox_id = $3`,
    [isRead, id, mailboxId]
  );
  return { success: res.rowCount > 0 };
}

export async function pgToggleStarEmail(id, mailboxId) {
  const res = await pool.query(
    `UPDATE emails 
     SET is_starred = CASE WHEN is_starred = 1 THEN 0 ELSE 1 END 
     WHERE id = $1 AND mailbox_id = $2`,
    [id, mailboxId]
  );
  return { success: res.rowCount > 0 };
}

export async function pgDeleteEmail(id, mailboxId) {
  const check = await pool.query(`SELECT folder FROM emails WHERE id = $1 AND mailbox_id = $2`, [id, mailboxId]);
  const email = check.rows[0];
  if (!email) return { error: 'Email not found or access denied' };

  if (email.folder === 'trash') {
    await pool.query(`DELETE FROM emails WHERE id = $1 AND mailbox_id = $2`, [id, mailboxId]);
    return { success: true, permanent: true };
  } else {
    await pool.query(`UPDATE emails SET folder = 'trash' WHERE id = $1 AND mailbox_id = $2`, [id, mailboxId]);
    return { success: true, movedToTrash: true };
  }
}

export async function pgRecordInboundEvent(eventId, eventType, payload) {
  const res = await pool.query(
    `INSERT INTO inbound_events (event_id, event_type, payload, status)
     VALUES ($1, $2, $3, 'pending')
     RETURNING id`,
    [eventId, eventType, typeof payload === 'string' ? payload : JSON.stringify(payload)]
  );
  return res.rows[0].id;
}

export async function pgGetInboundEventById(eventId) {
  const res = await pool.query(`SELECT * FROM inbound_events WHERE event_id = $1`, [eventId]);
  return res.rows[0] || null;
}

export async function pgGetPendingInboundEvents(limit = 20) {
  const res = await pool.query(
    `SELECT * FROM inbound_events 
     WHERE status IN ('pending', 'failed') AND attempts < max_attempts
     ORDER BY created_at ASC 
     LIMIT $1`,
    [limit]
  );
  return res.rows;
}

export async function pgUpdateInboundEventStatus(id, status, lastError = null) {
  await pool.query(
    `UPDATE inbound_events 
     SET status = $1, last_error = $2, attempts = attempts + 1,
         processed_at = CASE WHEN $1 = 'completed' THEN CURRENT_TIMESTAMP ELSE processed_at END
     WHERE id = $3`,
    [status, lastError, id]
  );
}

export async function pgLogSmtp(type, clientIp, sender, recipient, status, details) {
  await pool.query(
    `INSERT INTO smtp_logs (type, client_ip, sender, recipient, status, details)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [type, clientIp, sender, recipient, status, details]
  );
}

export async function pgGetSmtpLogs(limit = 50) {
  const res = await pool.query(`SELECT * FROM smtp_logs ORDER BY created_at DESC LIMIT $1`, [limit]);
  return res.rows;
}

export async function pgGetStats() {
  const d = await pool.query(`SELECT COUNT(*)::int as count FROM domains`);
  const m = await pool.query(`SELECT COUNT(*)::int as count FROM mailboxes`);
  const e = await pool.query(`SELECT COUNT(*)::int as count FROM emails`);
  const u = await pool.query(`SELECT COUNT(*)::int as count FROM emails WHERE is_read = 0 AND folder = 'inbox'`);
  const ev = await pool.query(`SELECT COUNT(*)::int as count FROM inbound_events`);

  return {
    domainsCount: d.rows[0].count,
    mailboxesCount: m.rows[0].count,
    emailsCount: e.rows[0].count,
    unreadCount: u.rows[0].count,
    inboundEventsCount: ev.rows[0].count
  };
}

export async function pgCreateQueueItem(mailboxId, toAddress, subject, mxHost) {
  const res = await pool.query(
    `INSERT INTO outbound_queue (mailbox_id, to_address, subject, mx_host)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [mailboxId, toAddress, subject, mxHost]
  );
  return res.rows[0].id;
}

export async function pgUpdateQueueItem(id, status, error = null) {
  await pool.query(
    `UPDATE outbound_queue 
     SET status = $1, last_error = $2, attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP
     WHERE id = $3`,
    [status, error, id]
  );
}

export async function pgIsEmailAlreadyProcessed(providerEmailId, mailboxId) {
  if (!providerEmailId) return false;
  const res = await pool.query(
    `SELECT id FROM emails WHERE provider_email_id = $1 AND mailbox_id = $2 LIMIT 1`,
    [providerEmailId, mailboxId]
  );
  return res.rows.length > 0;
}
