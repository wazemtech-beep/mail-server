import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.resolve(__dirname, '../../mailserver.db');

export const db = new DatabaseSync(dbPath);

// ============================================================================
// DATABASE SCHEMA & SAFE MIGRATIONS
// ============================================================================

db.exec(`
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS domains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    status TEXT DEFAULT 'active',
    dkim_selector TEXT DEFAULT 'default',
    dkim_private_key TEXT NOT NULL,
    dkim_public_key TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS mailboxes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain_id INTEGER NOT NULL,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    quota_mb INTEGER DEFAULT 1024,
    api_token TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(domain_id) REFERENCES domains(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS emails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mailbox_id INTEGER NOT NULL,
    folder TEXT DEFAULT 'inbox',
    direction TEXT DEFAULT 'inbound',
    from_address TEXT NOT NULL,
    from_name TEXT,
    to_address TEXT NOT NULL,
    subject TEXT,
    body_text TEXT,
    body_html TEXT,
    is_read INTEGER DEFAULT 0,
    is_starred INTEGER DEFAULT 0,
    raw_headers TEXT,
    message_id TEXT,
    dkim_status TEXT DEFAULT 'none',
    delivery_status TEXT DEFAULT 'delivered',
    provider_email_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    content_type TEXT,
    size INTEGER,
    data_base64 TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(email_id) REFERENCES emails(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS outbound_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mailbox_id INTEGER NOT NULL,
    to_address TEXT NOT NULL,
    subject TEXT,
    status TEXT DEFAULT 'pending',
    attempts INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 5,
    last_error TEXT,
    mx_host TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS inbound_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT UNIQUE NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    attempts INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 5,
    last_error TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    processed_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS smtp_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT,
    client_ip TEXT,
    sender TEXT,
    recipient TEXT,
    status TEXT,
    details TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Safe migration: Ensure provider_email_id exists in emails table
try {
  const tableInfo = db.prepare(`PRAGMA table_info(emails)`).all();
  const hasProviderId = tableInfo.some((col) => col.name === 'provider_email_id');
  if (!hasProviderId) {
    db.exec(`ALTER TABLE emails ADD COLUMN provider_email_id TEXT;`);
  }
} catch (e) {
  console.warn('[DB Migration Warning]:', e.message);
}

// Ensure unique index for idempotency across provider emails per mailbox
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_emails_provider_mailbox ON emails(provider_email_id, mailbox_id);
  CREATE INDEX IF NOT EXISTS idx_inbound_events_status ON inbound_events(status);
`);

// ============================================================================
// SECURITY HELPERS (Scrypt & DKIM)
// ============================================================================

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(password, salt, 64);
  return `${salt}:${derivedKey.toString('hex')}`;
}

export function verifyPassword(password, storedHash) {
  if (!password || !storedHash || !storedHash.includes(':')) {
    return false;
  }
  const [salt, key] = storedHash.split(':');
  const keyBuffer = Buffer.from(key, 'hex');
  const derivedBuffer = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(keyBuffer, derivedBuffer);
}

export function generateDkimKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem'
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem'
    }
  });

  const cleanPublicKey = publicKey
    .replace('-----BEGIN PUBLIC KEY-----', '')
    .replace('-----END PUBLIC KEY-----', '')
    .replace(/\r?\n|\r/g, '');

  return { privateKey, publicKey: cleanPublicKey };
}

// ============================================================================
// DOMAIN OPERATIONS
// ============================================================================

export function createDomain(name) {
  const normalized = name.trim().toLowerCase();
  const { privateKey, publicKey } = generateDkimKeys();

  const insert = db.prepare(`
    INSERT INTO domains (name, status, dkim_selector, dkim_private_key, dkim_public_key)
    VALUES (?, 'active', 'default', ?, ?)
  `);
  const result = insert.run(normalized, privateKey, publicKey);
  return getDomainById(result.lastInsertRowid, false);
}

export function getDomains(includePrivateKeys = false) {
  const fields = includePrivateKeys
    ? `d.*`
    : `d.id, d.name, d.status, d.dkim_selector, d.dkim_public_key, d.created_at`;

  const query = db.prepare(`
    SELECT ${fields}, 
      (SELECT COUNT(*) FROM mailboxes WHERE domain_id = d.id) as mailbox_count
    FROM domains d
    ORDER BY d.created_at DESC
  `);
  return query.all();
}

export function getDomainByName(name, includePrivateKeys = false) {
  const normalized = name.trim().toLowerCase();
  const fields = includePrivateKeys
    ? `*`
    : `id, name, status, dkim_selector, dkim_public_key, created_at`;
  const query = db.prepare(`SELECT ${fields} FROM domains WHERE name = ?`);
  return query.get(normalized);
}

export function getDomainById(id, includePrivateKeys = false) {
  const fields = includePrivateKeys
    ? `*`
    : `id, name, status, dkim_selector, dkim_public_key, created_at`;
  const query = db.prepare(`SELECT ${fields} FROM domains WHERE id = ?`);
  return query.get(id);
}

// ============================================================================
// MAILBOX OPERATIONS
// ============================================================================

export function createMailbox(domainId, email, name, plainPassword) {
  const normalizedEmail = email.trim().toLowerCase();
  const domain = getDomainById(domainId, false);
  if (!domain) {
    throw new Error('Target domain does not exist');
  }

  const emailParts = normalizedEmail.split('@');
  if (emailParts.length !== 2 || emailParts[1] !== domain.name) {
    throw new Error(`Email address domain (${emailParts[1] || 'none'}) must match selected domain (${domain.name})`);
  }

  const passwordHash = hashPassword(plainPassword);
  const apiToken = crypto.randomBytes(32).toString('hex');

  const insert = db.prepare(`
    INSERT INTO mailboxes (domain_id, email, name, password_hash, api_token)
    VALUES (?, ?, ?, ?, ?)
  `);
  const result = insert.run(domainId, normalizedEmail, name.trim(), passwordHash, apiToken);
  return getMailboxById(result.lastInsertRowid, false);
}

export function getMailboxes(domainId = null, includeSecrets = false) {
  const fields = includeSecrets
    ? `m.*, d.name as domain_name`
    : `m.id, m.domain_id, m.email, m.name, m.quota_mb, m.api_token, m.created_at, d.name as domain_name`;

  if (domainId) {
    const query = db.prepare(`
      SELECT ${fields},
        (SELECT COUNT(*) FROM emails WHERE mailbox_id = m.id AND is_read = 0 AND folder = 'inbox') as unread_count
      FROM mailboxes m
      JOIN domains d ON m.domain_id = d.id
      WHERE m.domain_id = ?
      ORDER BY m.created_at ASC
    `);
    return query.all(domainId);
  }

  const query = db.prepare(`
    SELECT ${fields},
      (SELECT COUNT(*) FROM emails WHERE mailbox_id = m.id AND is_read = 0 AND folder = 'inbox') as unread_count
    FROM mailboxes m
    JOIN domains d ON m.domain_id = d.id
    ORDER BY m.created_at ASC
  `);
  return query.all();
}

export function getMailboxByEmail(email, includeSecrets = false) {
  if (!email) return null;
  const normalized = email.trim().toLowerCase();
  const query = db.prepare(`
    SELECT m.*, d.name as domain_name, d.dkim_private_key, d.dkim_selector
    FROM mailboxes m
    JOIN domains d ON m.domain_id = d.id
    WHERE m.email = ?
  `);
  const mailbox = query.get(normalized);
  if (!mailbox) return null;

  if (!includeSecrets) {
    delete mailbox.password_hash;
    delete mailbox.dkim_private_key;
  }
  return mailbox;
}

export function getMailboxById(id, includeSecrets = false) {
  const query = db.prepare(`
    SELECT m.*, d.name as domain_name, d.dkim_private_key, d.dkim_selector
    FROM mailboxes m
    JOIN domains d ON m.domain_id = d.id
    WHERE m.id = ?
  `);
  const mailbox = query.get(id);
  if (!mailbox) return null;

  if (!includeSecrets) {
    delete mailbox.password_hash;
    delete mailbox.dkim_private_key;
  }
  return mailbox;
}

// ============================================================================
// EMAIL OPERATIONS & ATOMIC PERSISTENCE
// ============================================================================

export function isEmailAlreadyProcessed(providerEmailId, mailboxId) {
  if (!providerEmailId) return false;
  const query = db.prepare(`
    SELECT id FROM emails WHERE provider_email_id = ? AND mailbox_id = ?
  `);
  return Boolean(query.get(providerEmailId, mailboxId));
}

export function saveEmail({
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
  // Idempotency check for external provider email IDs
  if (providerEmailId) {
    const existing = db.prepare(`
      SELECT id FROM emails WHERE provider_email_id = ? AND mailbox_id = ?
    `).get(providerEmailId, mailboxId);
    if (existing) {
      console.log(`[Idempotency]: Email ${providerEmailId} already saved in mailbox ${mailboxId}. Skipping.`);
      return getEmailById(existing.id, mailboxId);
    }
  }

  db.exec('BEGIN TRANSACTION');
  try {
    const insert = db.prepare(`
      INSERT INTO emails (
        mailbox_id, folder, direction, from_address, from_name, 
        to_address, subject, body_text, body_html, raw_headers, message_id,
        dkim_status, delivery_status, provider_email_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = insert.run(
      mailboxId,
      folder,
      direction,
      fromAddress,
      fromName || '',
      toAddress,
      subject || '(No Subject)',
      bodyText || '',
      bodyHtml || '',
      typeof rawHeaders === 'object' ? JSON.stringify(rawHeaders) : (rawHeaders || ''),
      messageId || '',
      dkimStatus,
      deliveryStatus,
      providerEmailId
    );

    const emailId = result.lastInsertRowid;

    if (attachments && attachments.length > 0) {
      const insertAtt = db.prepare(`
        INSERT INTO attachments (email_id, filename, content_type, size, data_base64)
        VALUES (?, ?, ?, ?, ?)
      `);

      for (const att of attachments) {
        let base64Data = att.data_base64 || '';
        if (!base64Data && att.content) {
          base64Data = Buffer.isBuffer(att.content) ? att.content.toString('base64') : String(att.content);
        }

        insertAtt.run(
          emailId,
          att.filename || 'attachment.bin',
          att.contentType || att.content_type || 'application/octet-stream',
          att.size || 0,
          base64Data
        );
      }
    }

    db.exec('COMMIT');
    return getEmailById(emailId, mailboxId);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getEmails(mailboxId, folder = 'inbox') {
  const query = db.prepare(`
    SELECT e.*, 
      (SELECT COUNT(*) FROM attachments WHERE email_id = e.id) as attachment_count
    FROM emails e
    WHERE e.mailbox_id = ? AND e.folder = ?
    ORDER BY e.created_at DESC
  `);
  return query.all(mailboxId, folder);
}

export function getEmailById(emailId, mailboxId = null) {
  let email;
  if (mailboxId) {
    const query = db.prepare(`SELECT * FROM emails WHERE id = ? AND mailbox_id = ?`);
    email = query.get(emailId, mailboxId);
  } else {
    const query = db.prepare(`SELECT * FROM emails WHERE id = ?`);
    email = query.get(emailId);
  }

  if (!email) return null;

  const attQuery = db.prepare(`
    SELECT id, filename, content_type, size, data_base64 
    FROM attachments 
    WHERE email_id = ?
  `);
  email.attachments = attQuery.all(emailId);
  return email;
}

export function getAttachmentById(attachmentId, mailboxId) {
  const query = db.prepare(`
    SELECT a.*, e.mailbox_id 
    FROM attachments a
    JOIN emails e ON a.email_id = e.id
    WHERE a.id = ? AND e.mailbox_id = ?
  `);
  return query.get(attachmentId, mailboxId);
}

export function markEmailRead(id, mailboxId, isRead = 1) {
  const update = db.prepare(`UPDATE emails SET is_read = ? WHERE id = ? AND mailbox_id = ?`);
  const result = update.run(isRead, id, mailboxId);
  return { success: result.changes > 0 };
}

export function toggleStarEmail(id, mailboxId) {
  const update = db.prepare(`
    UPDATE emails 
    SET is_starred = CASE WHEN is_starred = 1 THEN 0 ELSE 1 END 
    WHERE id = ? AND mailbox_id = ?
  `);
  const result = update.run(id, mailboxId);
  return { success: result.changes > 0 };
}

export function deleteEmail(id, mailboxId) {
  const query = db.prepare(`SELECT folder FROM emails WHERE id = ? AND mailbox_id = ?`);
  const email = query.get(id, mailboxId);
  if (!email) return { error: 'Email not found or unauthorized' };

  if (email.folder === 'trash') {
    const del = db.prepare(`DELETE FROM emails WHERE id = ? AND mailbox_id = ?`);
    del.run(id, mailboxId);
    return { success: true, permanent: true };
  } else {
    const move = db.prepare(`UPDATE emails SET folder = 'trash' WHERE id = ? AND mailbox_id = ?`);
    move.run(id, mailboxId);
    return { success: true, movedToTrash: true };
  }
}

// ============================================================================
// INBOUND EVENTS (Persistent Webhook Queue)
// ============================================================================

export function recordInboundEvent(eventId, eventType, payload) {
  const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const insert = db.prepare(`
    INSERT INTO inbound_events (event_id, event_type, payload, status)
    VALUES (?, ?, ?, 'pending')
  `);
  return insert.run(eventId, eventType, payloadStr).lastInsertRowid;
}

export function getInboundEventById(eventId) {
  const query = db.prepare(`SELECT * FROM inbound_events WHERE event_id = ?`);
  return query.get(eventId);
}

export function getPendingInboundEvents(limit = 20) {
  const query = db.prepare(`
    SELECT * FROM inbound_events 
    WHERE status IN ('pending', 'failed') AND attempts < max_attempts
    ORDER BY created_at ASC 
    LIMIT ?
  `);
  return query.all(limit);
}

export function updateInboundEventStatus(id, status, lastError = null) {
  const update = db.prepare(`
    UPDATE inbound_events 
    SET status = ?, last_error = ?, attempts = attempts + 1,
        processed_at = CASE WHEN ? = 'completed' THEN CURRENT_TIMESTAMP ELSE processed_at END
    WHERE id = ?
  `);
  update.run(status, lastError, status, id);
}

// Outbound Queue Operations
export function createQueueItem(mailboxId, toAddress, subject, mxHost) {
  const insert = db.prepare(`
    INSERT INTO outbound_queue (mailbox_id, to_address, subject, mx_host)
    VALUES (?, ?, ?, ?)
  `);
  return insert.run(mailboxId, toAddress, subject, mxHost).lastInsertRowid;
}

export function updateQueueItem(id, status, error = null) {
  const update = db.prepare(`
    UPDATE outbound_queue 
    SET status = ?, last_error = ?, attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  update.run(status, error, id);
}

// Logs & Stats
export function logSmtp(type, clientIp, sender, recipient, status, details) {
  const insert = db.prepare(`
    INSERT INTO smtp_logs (type, client_ip, sender, recipient, status, details)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  insert.run(type, clientIp, sender, recipient, status, details);
}

export function getSmtpLogs(limit = 50) {
  const query = db.prepare(`SELECT * FROM smtp_logs ORDER BY created_at DESC LIMIT ?`);
  return query.all(limit);
}

export function getStats() {
  const domainsCount = db.prepare(`SELECT COUNT(*) as count FROM domains`).get().count;
  const mailboxesCount = db.prepare(`SELECT COUNT(*) as count FROM mailboxes`).get().count;
  const emailsCount = db.prepare(`SELECT COUNT(*) as count FROM emails`).get().count;
  const unreadCount = db.prepare(`SELECT COUNT(*) as count FROM emails WHERE is_read = 0 AND folder = 'inbox'`).get().count;
  const inboundEventsCount = db.prepare(`SELECT COUNT(*) as count FROM inbound_events`).get().count;

  return {
    domainsCount,
    mailboxesCount,
    emailsCount,
    unreadCount,
    inboundEventsCount
  };
}
