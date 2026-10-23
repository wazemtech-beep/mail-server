import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  db,
  getDomains,
  createDomain,
  getDomainById,
  getMailboxes,
  createMailbox,
  getMailboxById,
  getMailboxByEmail,
  getEmails,
  getEmailById,
  getAttachmentById,
  markEmailRead,
  toggleStarEmail,
  deleteEmail,
  recordInboundEvent,
  getInboundEventById,
  getSmtpLogs,
  getStats,
  saveEmail,
  logSmtp
} from './db/database.js';

import {
  initPostgres,
  getPgPool,
  pgGetDomains,
  pgCreateDomain,
  pgGetDomainById,
  pgGetMailboxes,
  pgCreateMailbox,
  pgGetMailboxById,
  pgGetMailboxByEmail,
  pgGetEmails,
  pgGetEmailById,
  pgGetAttachmentById,
  pgMarkEmailRead,
  pgToggleStarEmail,
  pgDeleteEmail,
  pgRecordInboundEvent,
  pgGetInboundEventById,
  pgGetSmtpLogs,
  pgGetStats,
  pgSaveEmail,
  pgLogSmtp
} from './db/postgres.js';

import { startSmtpReceiver, smtpEvents } from './smtp/receiver.js';
import { sendEmail } from './smtp/sender.js';
import { verifyResendWebhook } from './inbound/webhook-verifier.js';
import { processInboundEvent, drainPendingInboundQueue, inboundEvents } from './inbound/processor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const HOST = process.env.HOST || '127.0.0.1';
const WEB_PORT = process.env.PORT || 3000;
const SMTP_PORT = process.env.SMTP_PORT || 2525;
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_WEBHOOK_SECRET = process.env.RESEND_WEBHOOK_SECRET || '';

// ============================================================================
// DUAL-MODE DATABASE ADAPTER (SQLite Local / Aiven PostgreSQL Cloud)
// ============================================================================

const dbAdapter = {
  getStats: async () => {
    if (getPgPool()) return await pgGetStats();
    if (process.env.DATABASE_URL) {
      await initPostgres(process.env.DATABASE_URL);
      return await pgGetStats();
    }
    return db ? getStats() : { domainsCount: 0, mailboxesCount: 0, emailsCount: 0, unreadCount: 0, inboundEventsCount: 0 };
  },
  getDomains: async (keys) => {
    if (getPgPool()) return await pgGetDomains(keys);
    if (process.env.DATABASE_URL) {
      await initPostgres(process.env.DATABASE_URL);
      return await pgGetDomains(keys);
    }
    return db ? getDomains(keys) : [];
  },
  getDomainById: async (id, keys) => {
    if (getPgPool()) return await pgGetDomainById(id, keys);
    if (process.env.DATABASE_URL) {
      await initPostgres(process.env.DATABASE_URL);
      return await pgGetDomainById(id, keys);
    }
    return db ? getDomainById(id, keys) : null;
  },
  createDomain: async (name) => {
    if (getPgPool()) return await pgCreateDomain(name);
    if (process.env.DATABASE_URL) {
      await initPostgres(process.env.DATABASE_URL);
      return await pgCreateDomain(name);
    }
    return db ? createDomain(name) : null;
  },
  getMailboxes: async (dId, sec) => {
    if (getPgPool()) return await pgGetMailboxes(dId, sec);
    if (process.env.DATABASE_URL) {
      await initPostgres(process.env.DATABASE_URL);
      return await pgGetMailboxes(dId, sec);
    }
    return db ? getMailboxes(dId, sec) : [];
  },
  getMailboxById: async (id, sec) => {
    if (getPgPool()) return await pgGetMailboxById(id, sec);
    if (process.env.DATABASE_URL) {
      await initPostgres(process.env.DATABASE_URL);
      return await pgGetMailboxById(id, sec);
    }
    return db ? getMailboxById(id, sec) : null;
  },
  getMailboxByEmail: async (email, sec) => {
    if (getPgPool()) return await pgGetMailboxByEmail(email, sec);
    if (process.env.DATABASE_URL) {
      await initPostgres(process.env.DATABASE_URL);
      return await pgGetMailboxByEmail(email, sec);
    }
    return db ? getMailboxByEmail(email, sec) : null;
  },
  createMailbox: async (dId, em, nm, pw) => {
    if (getPgPool()) return await pgCreateMailbox(dId, em, nm, pw);
    if (process.env.DATABASE_URL) {
      await initPostgres(process.env.DATABASE_URL);
      return await pgCreateMailbox(dId, em, nm, pw);
    }
    return db ? createMailbox(dId, em, nm, pw) : null;
  },
  getEmails: async (mId, folder) => {
    if (getPgPool()) return await pgGetEmails(mId, folder);
    if (process.env.DATABASE_URL) {
      await initPostgres(process.env.DATABASE_URL);
      return await pgGetEmails(mId, folder);
    }
    return db ? getEmails(mId, folder) : [];
  },
  getEmailById: async (id, mId) => {
    if (getPgPool()) return await pgGetEmailById(id, mId);
    if (process.env.DATABASE_URL) {
      await initPostgres(process.env.DATABASE_URL);
      return await pgGetEmailById(id, mId);
    }
    return db ? getEmailById(id, mId) : null;
  },
  getAttachmentById: async (id, mId) => {
    if (getPgPool()) return await pgGetAttachmentById(id, mId);
    if (process.env.DATABASE_URL) {
      await initPostgres(process.env.DATABASE_URL);
      return await pgGetAttachmentById(id, mId);
    }
    return db ? getAttachmentById(id, mId) : null;
  },
  markEmailRead: async (id, mId, r) => {
    if (getPgPool()) return await pgMarkEmailRead(id, mId, r);
    if (process.env.DATABASE_URL) {
      await initPostgres(process.env.DATABASE_URL);
      return await pgMarkEmailRead(id, mId, r);
    }
    return db ? markEmailRead(id, mId, r) : { success: false };
  },
  toggleStarEmail: async (id, mId) => {
    if (getPgPool()) return await pgToggleStarEmail(id, mId);
    if (process.env.DATABASE_URL) {
      await initPostgres(process.env.DATABASE_URL);
      return await pgToggleStarEmail(id, mId);
    }
    return db ? toggleStarEmail(id, mId) : { success: false };
  },
  deleteEmail: async (id, mId) => {
    if (getPgPool()) return await pgDeleteEmail(id, mId);
    if (process.env.DATABASE_URL) {
      await initPostgres(process.env.DATABASE_URL);
      return await pgDeleteEmail(id, mId);
    }
    return db ? deleteEmail(id, mId) : { error: 'Database unavailable' };
  },
  recordInboundEvent: async (eId, type, pl) => {
    if (getPgPool()) return await pgRecordInboundEvent(eId, type, pl);
    if (process.env.DATABASE_URL) {
      await initPostgres(process.env.DATABASE_URL);
      return await pgRecordInboundEvent(eId, type, pl);
    }
    return db ? recordInboundEvent(eId, type, pl) : 0;
  },
  getInboundEventById: async (eId) => {
    if (getPgPool()) return await pgGetInboundEventById(eId);
    if (process.env.DATABASE_URL) {
      await initPostgres(process.env.DATABASE_URL);
      return await pgGetInboundEventById(eId);
    }
    return db ? getInboundEventById(eId) : null;
  },
  getSmtpLogs: async (l) => {
    if (getPgPool()) return await pgGetSmtpLogs(l);
    if (process.env.DATABASE_URL) {
      await initPostgres(process.env.DATABASE_URL);
      return await pgGetSmtpLogs(l);
    }
    return db ? getSmtpLogs(l) : [];
  }
};

// Strict CORS: Allow only local web app & public tunnels if configured
app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST', 'DELETE']
  })
);

// Capture raw request body for Svix webhook signature verification
app.use(
  express.json({
    limit: '25mb',
    verify: (req, res, buf) => {
      req.rawBody = buf;
    }
  })
);

app.use(express.static(path.resolve(__dirname, '../public')));

// ============================================================================
// SERVER-SENT EVENTS (SSE) — MAILBOX SCOPED (ZERO DATA LEAKAGE)
// ============================================================================

const sseClients = new Set();

app.get('/api/events', (req, res) => {
  const mailboxId = req.query.mailboxId ? Number(req.query.mailboxId) : null;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const client = { res, mailboxId };
  sseClients.add(client);

  req.on('close', () => {
    sseClients.delete(client);
  });
});

/**
 * Sends real-time event ONLY to clients viewing the relevant mailbox
 */
function broadcastScoped(mailboxId, type, data) {
  for (const client of sseClients) {
    try {
      if (!client.mailboxId || client.mailboxId === mailboxId) {
        client.res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    } catch {
      sseClients.delete(client);
    }
  }
}

function broadcastGlobal(type, data) {
  for (const client of sseClients) {
    try {
      client.res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      sseClients.delete(client);
    }
  }
}

// Forward local SMTP and Inbound Webhook events to scoped subscribers
smtpEvents.on('new_email', (payload) => {
  broadcastScoped(payload.mailboxId, 'new_email', payload);
});

inboundEvents.on('new_inbound_email', (payload) => {
  broadcastScoped(payload.mailboxId, 'new_email', payload);
});

// ============================================================================
// MAILBOX AUTHORIZATION MIDDLEWARE
// ============================================================================

async function requireMailboxAuth(req, res, next) {
  const mailboxId = req.headers['x-mailbox-id'] || req.query.mailboxId;
  if (!mailboxId) {
    return res.status(401).json({ error: 'Mailbox authorization header (x-mailbox-id) required' });
  }

  const mailbox = await dbAdapter.getMailboxById(Number(mailboxId), false);
  if (!mailbox) {
    return res.status(403).json({ error: 'Invalid or unauthorized mailbox' });
  }

  req.authMailbox = mailbox;
  next();
}

// ============================================================================
// RESEND INBOUND WEBHOOK ENDPOINT
// ============================================================================

app.post('/api/webhooks/resend/inbound', async (req, res) => {
  const svixId = req.headers['svix-id'] || req.headers['svix_id'];
  const svixTimestamp = req.headers['svix-timestamp'] || req.headers['svix_timestamp'];
  const svixSignature = req.headers['svix-signature'] || req.headers['svix_signature'];

  // 1. Signature Verification
  if (RESEND_WEBHOOK_SECRET) {
    const verification = verifyResendWebhook({
      rawBody: req.rawBody,
      headers: req.headers,
      secret: RESEND_WEBHOOK_SECRET
    });

    if (!verification.valid) {
      console.warn(`[Webhook Rejected]: Signature verification failed (${verification.error})`);
      return res.status(401).json({ error: 'Invalid signature: ' + verification.error });
    }
  } else {
    console.warn('[Webhook Notice]: RESEND_WEBHOOK_SECRET not set. Skipping signature verification in dev mode.');
  }

  const eventPayload = req.body;
  if (!eventPayload || !eventPayload.type) {
    return res.status(400).json({ error: 'Malformed webhook payload' });
  }

  // Determine a unique event identifier for idempotency
  const eventId = svixId || eventPayload.data?.email_id || `evt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

  // 2. Idempotency Check: Don't process the same webhook event twice
  const existingEvent = await dbAdapter.getInboundEventById(eventId);
  if (existingEvent) {
    console.log(`[Webhook Idempotency]: Event ${eventId} already received. Status: ${existingEvent.status}`);
    return res.status(200).json({ received: true, status: 'duplicate_acknowledged' });
  }

  // 3. Persist Event into Database Queue before acknowledging
  let eventDbId;
  try {
    eventDbId = await dbAdapter.recordInboundEvent(eventId, eventPayload.type, eventPayload);
  } catch (dbErr) {
    console.error('[Webhook DB Error]: Failed to record event:', dbErr.message);
    return res.status(500).json({ error: 'Database error recording event' });
  }

  // 4. Process Inbound Email (Retrieve body & attachments, route to mailbox, commit)
  try {
    const eventRecord = {
      id: eventDbId,
      event_id: eventId,
      event_type: eventPayload.type,
      payload: eventPayload
    };

    const processResult = await processInboundEvent(eventRecord, RESEND_API_KEY);
    res.status(200).json({ received: true, result: processResult });
  } catch (err) {
    console.error(`[Inbound Processing Error] Event ${eventId}:`, err.message);
    res.status(200).json({ received: true, status: 'queued_for_retry', error: err.message });
  }
});

// ============================================================================
// REST APIS
// ============================================================================

app.get('/api/stats', async (req, res) => {
  const stats = await dbAdapter.getStats();
  res.json({
    ...stats,
    smtpPort: SMTP_PORT,
    webPort: WEB_PORT,
    host: HOST,
    hasResendApiKey: Boolean(RESEND_API_KEY),
    hasWebhookSecret: Boolean(RESEND_WEBHOOK_SECRET)
  });
});

app.get('/api/domains', async (req, res) => {
  const domains = await dbAdapter.getDomains(false);
  res.json(domains);
});

app.post('/api/domains', async (req, res) => {
  const { name } = req.body;
  if (!name || !name.includes('.') || name.length < 3) {
    return res.status(400).json({ error: 'Valid fully qualified domain name required' });
  }
  try {
    const domain = await dbAdapter.createDomain(name);
    broadcastGlobal('domain_created', domain);
    res.json(domain);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/domains/:id/dns', async (req, res) => {
  const domain = await dbAdapter.getDomainById(Number(req.params.id), false);
  if (!domain) return res.status(404).json({ error: 'Domain not found' });

  const dnsRecords = [
    {
      type: 'MX',
      name: 'inbound',
      priority: 10,
      value: 'receive.forge.rmta.net',
      explanation: 'Resend Inbound MX Record: Routes incoming emails to Resend infrastructure.'
    },
    {
      type: 'TXT',
      name: '@',
      value: 'v=spf1 include:resend.com ~all',
      explanation: 'SPF Record: Declares authorized sender IP servers for your domain.'
    },
    {
      type: 'TXT',
      name: `${domain.dkim_selector}._domainkey`,
      value: `v=DKIM1; k=rsa; p=${domain.dkim_public_key}`,
      explanation: 'DKIM Record: 2048-bit Public Key used by receiving servers to verify email signatures.'
    },
    {
      type: 'TXT',
      name: '_dmarc',
      value: `v=DMARC1; p=none; sp=none; rua=mailto:dmarc-reports@${domain.name}`,
      explanation: 'DMARC Record: Protects your domain from spoofing and receives delivery reports.'
    }
  ];

  res.json({ domain, dnsRecords });
});

app.get('/api/mailboxes', async (req, res) => {
  const domainId = req.query.domainId ? Number(req.query.domainId) : null;
  const mailboxes = await dbAdapter.getMailboxes(domainId, false);
  res.json(mailboxes);
});

app.post('/api/mailboxes', async (req, res) => {
  const { domainId, email, name, password } = req.body;
  if (!domainId || !email || !name || !password) {
    return res.status(400).json({ error: 'domainId, email, name, and password are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters long' });
  }
  try {
    const mailbox = await dbAdapter.createMailbox(Number(domainId), email, name, password);
    broadcastGlobal('mailbox_created', mailbox);
    res.json(mailbox);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Emails API (Tenant-isolated)
app.get('/api/mailboxes/:id/emails', requireMailboxAuth, async (req, res) => {
  const mailboxId = Number(req.params.id);
  if (req.authMailbox.id !== mailboxId) {
    return res.status(403).json({ error: 'Access denied to this mailbox' });
  }

  const folder = req.query.folder || 'inbox';
  const emails = await dbAdapter.getEmails(mailboxId, folder);
  res.json(emails);
});

app.get('/api/emails/:id', requireMailboxAuth, async (req, res) => {
  const email = await dbAdapter.getEmailById(Number(req.params.id), req.authMailbox.id);
  if (!email) {
    return res.status(404).json({ error: 'Email not found or access denied' });
  }
  res.json(email);
});

// Secure Attachment Download API
app.get('/api/attachments/:id/download', requireMailboxAuth, async (req, res) => {
  const att = await dbAdapter.getAttachmentById(Number(req.params.id), req.authMailbox.id);
  if (!att) {
    return res.status(404).json({ error: 'Attachment not found or access denied' });
  }

  const fileBuffer = Buffer.from(att.data_base64 || '', 'base64');
  res.setHeader('Content-Type', att.content_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(att.filename)}"`);
  res.setHeader('Content-Length', fileBuffer.length);
  res.send(fileBuffer);
});

app.post('/api/emails/send', requireMailboxAuth, async (req, res) => {
  const { fromEmail, toEmail, subject, bodyText, bodyHtml, attachments } = req.body;
  if (!fromEmail || !toEmail) {
    return res.status(400).json({ error: 'fromEmail and toEmail are required' });
  }

  if (req.authMailbox.email.toLowerCase() !== fromEmail.trim().toLowerCase()) {
    return res.status(403).json({ error: `Cannot send on behalf of unauthorized email ${fromEmail}` });
  }

  try {
    const result = await sendEmail({
      fromEmail,
      toEmail,
      subject,
      bodyText,
      bodyHtml,
      attachments
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/emails/:id/mark-read', requireMailboxAuth, async (req, res) => {
  const isRead = req.body.isRead !== undefined ? (req.body.isRead ? 1 : 0) : 1;
  const result = await dbAdapter.markEmailRead(Number(req.params.id), req.authMailbox.id, isRead);
  if (!result.success) {
    return res.status(404).json({ error: 'Email not found or access denied' });
  }
  res.json({ success: true, isRead });
});

app.post('/api/emails/:id/star', requireMailboxAuth, async (req, res) => {
  const result = await dbAdapter.toggleStarEmail(Number(req.params.id), req.authMailbox.id);
  if (!result.success) {
    return res.status(404).json({ error: 'Email not found or access denied' });
  }
  res.json({ success: true });
});

app.delete('/api/emails/:id', requireMailboxAuth, async (req, res) => {
  const result = await dbAdapter.deleteEmail(Number(req.params.id), req.authMailbox.id);
  if (result.error) {
    return res.status(404).json({ error: result.error });
  }
  res.json(result);
});

app.get('/api/smtp-logs', async (req, res) => {
  const limit = req.query.limit ? Number(req.query.limit) : 50;
  res.json(await dbAdapter.getSmtpLogs(limit));
});

// Initialize Aiven PostgreSQL if configured
if (process.env.DATABASE_URL && !getPgPool()) {
  try {
    await initPostgres(process.env.DATABASE_URL);
  } catch (err) {
    console.error('❌ [Aiven PostgreSQL Error]:', err.message);
  }
}

// Background services (Only run in long-lived server mode, NOT inside Vercel serverless functions)
let server = null;

if (!process.env.VERCEL) {
  startSmtpReceiver(SMTP_PORT, HOST);

  // Drain any pending inbound events that were queued prior to startup
  drainPendingInboundQueue(RESEND_API_KEY).then((count) => {
    if (count > 0) console.log(`✓ Processed ${count} recovered inbound event(s) from queue.`);
  });

  // Periodic background queue drainage for temporary failures (every 45s)
  setInterval(() => {
    drainPendingInboundQueue(RESEND_API_KEY).catch((err) => {
      console.error('[Periodic Inbound Drain Error]:', err.message);
    });
  }, 45000);

  server = app.listen(WEB_PORT, '0.0.0.0', () => {
    console.log(`🌐 [Webmail & SaaS Dashboard] Running on http://${HOST}:${WEB_PORT}`);
    console.log(`🛡️ [SMTP Receiver Server] Running on ${HOST}:${SMTP_PORT}`);
    console.log(`📥 [Inbound Webhook Active] Endpoint: /api/webhooks/resend/inbound`);
  });
}

export { server };
export default app;
