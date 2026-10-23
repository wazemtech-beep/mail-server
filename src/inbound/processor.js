import { EventEmitter } from 'node:events';
import { 
  getMailboxByEmail as sqliteGetMailboxByEmail, 
  saveEmail as sqliteSaveEmail, 
  isEmailAlreadyProcessed as sqliteIsEmailAlreadyProcessed, 
  updateInboundEventStatus as sqliteUpdateInboundEventStatus, 
  getPendingInboundEvents as sqliteGetPendingInboundEvents, 
  logSmtp as sqliteLogSmtp 
} from '../db/database.js';
import {
  getPgPool,
  pgGetMailboxByEmail,
  pgSaveEmail,
  pgIsEmailAlreadyProcessed,
  pgUpdateInboundEventStatus,
  pgGetPendingInboundEvents,
  pgLogSmtp
} from '../db/postgres.js';

const getMailboxByEmail = async (email, sec) => getPgPool() ? await pgGetMailboxByEmail(email, sec) : sqliteGetMailboxByEmail(email, sec);
const saveEmail = async (opts) => getPgPool() ? await pgSaveEmail(opts) : sqliteSaveEmail(opts);
const isEmailAlreadyProcessed = async (eId, mId) => getPgPool() ? await pgIsEmailAlreadyProcessed(eId, mId) : sqliteIsEmailAlreadyProcessed(eId, mId);
const updateInboundEventStatus = async (...args) => getPgPool() ? await pgUpdateInboundEventStatus(...args) : sqliteUpdateInboundEventStatus(...args);
const getPendingInboundEvents = async (l) => getPgPool() ? await pgGetPendingInboundEvents(l) : sqliteGetPendingInboundEvents(l);
const logSmtp = async (...args) => getPgPool() ? await pgLogSmtp(...args) : sqliteLogSmtp(...args);

export const inboundEvents = new EventEmitter();

const RESEND_API_BASE = 'https://api.resend.com';

/**
 * Retrieves full email contents from Resend Inbound API
 * @param {string} emailId - Resend email UUID
 * @param {string} apiKey - Resend API key
 */
export async function fetchReceivedEmailDetails(emailId, apiKey) {
  const url = `${RESEND_API_BASE}/emails/receiving/${encodeURIComponent(emailId)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'application/json'
    }
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Resend Inbound API error (${res.status}): ${errText}`);
  }

  return await res.json();
}

/**
 * Retrieves attachments from Resend Inbound Attachments API
 * @param {string} emailId - Resend email UUID
 * @param {string} apiKey - Resend API key
 * @param {number} [maxSizeBytes=26214400] - 25 MB max limit
 */
export async function fetchReceivedEmailAttachments(emailId, apiKey, maxSizeBytes = 25 * 1024 * 1024) {
  const url = `${RESEND_API_BASE}/emails/receiving/${encodeURIComponent(emailId)}/attachments`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'application/json'
    }
  });

  if (!res.ok) {
    // Some emails have no attachments or 404 if none exist
    if (res.status === 404) return [];
    const errText = await res.text();
    console.warn(`[Inbound Attachments Warn]: Failed to list attachments (${res.status}): ${errText}`);
    return [];
  }

  const data = await res.json();
  const attachmentList = Array.isArray(data) ? data : (data.data || []);
  const processed = [];

  for (const att of attachmentList) {
    try {
      if (att.size && att.size > maxSizeBytes) {
        console.warn(`[Attachment Skipped]: ${att.filename} exceeds max size limit (${att.size} > ${maxSizeBytes})`);
        continue;
      }

      // If binary content is provided via download_url
      if (att.download_url) {
        const fileRes = await fetch(att.download_url);
        if (fileRes.ok) {
          const arrayBuffer = await fileRes.arrayBuffer();
          const base64Content = Buffer.from(arrayBuffer).toString('base64');
          processed.push({
            filename: att.filename || 'attachment.bin',
            contentType: att.content_type || 'application/octet-stream',
            size: att.size || arrayBuffer.byteLength,
            data_base64: base64Content
          });
        }
      } else if (att.content) {
        // Direct base64 or string content
        processed.push({
          filename: att.filename || 'attachment.bin',
          contentType: att.content_type || 'application/octet-stream',
          size: att.size || Buffer.byteLength(att.content),
          data_base64: typeof att.content === 'string' ? att.content : Buffer.from(att.content).toString('base64')
        });
      }
    } catch (attErr) {
      console.error(`[Inbound Attachment Download Error]: Failed to fetch ${att.filename}:`, attErr.message);
    }
  }

  return processed;
}

/**
 * Parses raw addresses from strings or arrays like "Waseem <admin@domain.com>"
 */
export function extractEmailAddress(raw) {
  if (!raw) return '';
  const match = raw.match(/<([^>]+)>/);
  if (match) return match[1].trim().toLowerCase();
  return raw.trim().toLowerCase();
}

/**
 * Extracts sender display name
 */
export function extractDisplayName(raw) {
  if (!raw) return '';
  const match = raw.match(/^([^<]+)</);
  if (match) return match[1].trim().replace(/^["']|["']$/g, '');
  return '';
}

/**
 * Processes an inbound event record:
 * 1. Retrieves complete email details & attachments from Resend
 * 2. Matches recipients against existing mailboxes
 * 3. Commits messages idempotently to SQLite inside atomic transactions
 * 4. Emits mailbox-scoped SSE events for real-time UI updates
 * 
 * @param {Object} eventRecord - Database record from inbound_events
 * @param {string} apiKey - Resend API key
 */
export async function processInboundEvent(eventRecord, apiKey) {
  const payload = typeof eventRecord.payload === 'string' 
    ? JSON.parse(eventRecord.payload) 
    : eventRecord.payload;

  const eventType = payload.type || eventRecord.event_type;
  if (eventType !== 'email.received') {
    // Non-inbound event
    updateInboundEventStatus(eventRecord.id, 'completed');
    return { status: 'skipped', reason: 'Unrecognized event type: ' + eventType };
  }

  const data = payload.data || {};
  const emailId = data.email_id || data.id;

  if (!emailId) {
    updateInboundEventStatus(eventRecord.id, 'failed', 'Missing email_id in event payload');
    throw new Error('Missing email_id in event payload');
  }

  let fullEmail = data;
  let attachments = data.attachments || [];

  // If full body (html/text) is not included directly in webhook payload, fetch from API
  if (!fullEmail.html && !fullEmail.text && apiKey) {
    try {
      fullEmail = await fetchReceivedEmailDetails(emailId, apiKey);
    } catch (fetchErr) {
      console.warn(`[Inbound API Fetch Error]: ${fetchErr.message}. Checking if fallback payload usable.`);
      // If API fails, record failure so it can retry with backoff
      updateInboundEventStatus(eventRecord.id, 'failed', fetchErr.message);
      throw fetchErr;
    }
  }

  // Fetch attachments if not already present
  if ((!attachments || attachments.length === 0) && apiKey) {
    try {
      attachments = await fetchReceivedEmailAttachments(emailId, apiKey);
    } catch (attErr) {
      console.warn(`[Inbound Attachments Error]: ${attErr.message}`);
    }
  }

  // Extract recipient list (support To, CC, and received_for)
  const recipientList = [];
  const rawToList = Array.isArray(fullEmail.to) ? fullEmail.to : [fullEmail.to].filter(Boolean);
  const rawCcList = Array.isArray(fullEmail.cc) ? fullEmail.cc : [fullEmail.cc].filter(Boolean);
  const rawForList = Array.isArray(fullEmail.received_for) ? fullEmail.received_for : [fullEmail.received_for].filter(Boolean);

  for (const raw of [...rawToList, ...rawCcList, ...rawForList]) {
    const clean = extractEmailAddress(raw);
    if (clean && !recipientList.includes(clean)) {
      recipientList.push(clean);
    }
  }

  const senderAddr = extractEmailAddress(fullEmail.from) || 'unknown@external.sender';
  const senderName = extractDisplayName(fullEmail.from) || senderAddr;
  const subject = fullEmail.subject || '(No Subject)';
  const bodyText = fullEmail.text || '';
  const bodyHtml = fullEmail.html || (bodyText ? `<pre>${bodyText}</pre>` : '');
  const messageId = fullEmail.message_id || `<resend-${emailId}@inbound.local>`;
  const dkimStatus = fullEmail.authentication?.dkim || 'pass';

  let deliveredCount = 0;
  const deliveredMailboxIds = [];

  // Match each recipient against our virtual mailboxes table
  for (const recipient of recipientList) {
    const mailbox = await getMailboxByEmail(recipient, false);
    if (!mailbox) {
      // Do NOT create unknown mailboxes
      await logSmtp(
        'INBOUND_REJECT',
        'resend-webhook',
        senderAddr,
        recipient,
        'UNKNOWN_RECIPIENT',
        `No local mailbox configured for ${recipient}`
      );
      continue;
    }

    // Prevent duplicate delivery to the same mailbox
    if (deliveredMailboxIds.includes(mailbox.id)) {
      continue;
    }

    // Idempotency check: Don't insert duplicate provider email into the same mailbox
    if (await isEmailAlreadyProcessed(emailId, mailbox.id)) {
      console.log(`[Inbound Idempotency]: Email ${emailId} already exists in mailbox ${mailbox.email}`);
      deliveredMailboxIds.push(mailbox.id);
      deliveredCount++;
      continue;
    }

    // Normalize attachments
    const normalizedAttachments = (attachments || []).map(att => ({
      filename: att.filename || 'attachment.bin',
      contentType: att.content_type || att.contentType || 'application/octet-stream',
      size: att.size || (att.data_base64 ? Buffer.from(att.data_base64, 'base64').byteLength : 0),
      data_base64: att.data_base64 || (Buffer.isBuffer(att.content) ? att.content.toString('base64') : String(att.content || ''))
    }));

    // Save atomically into SQLite / PostgreSQL database
    const saved = await saveEmail({
      mailboxId: mailbox.id,
      folder: 'inbox',
      direction: 'inbound',
      fromAddress: senderAddr,
      fromName: senderName,
      toAddress: mailbox.email,
      subject: subject,
      bodyText: bodyText,
      bodyHtml: bodyHtml,
      rawHeaders: fullEmail.headers || {},
      messageId: messageId,
      dkimStatus: dkimStatus,
      deliveryStatus: 'delivered',
      providerEmailId: emailId,
      attachments: normalizedAttachments
    });

    deliveredMailboxIds.push(mailbox.id);
    deliveredCount++;

    await logSmtp(
      'INBOUND_DELIVERED',
      'resend-webhook',
      senderAddr,
      mailbox.email,
      'DELIVERED',
      `Subject: "${subject}", Attachments: ${attachments.length}, ProviderID: ${emailId}`
    );

    // Dispatch mailbox-scoped real-time event to SSE subscribers
    inboundEvents.emit('new_inbound_email', {
      mailboxId: mailbox.id,
      email: saved
    });
  }

  // Mark event status as completed
  await updateInboundEventStatus(eventRecord.id, 'completed');

  return {
    status: 'completed',
    deliveredCount,
    deliveredMailboxIds,
    recipients: recipientList,
    sender: senderAddr
  };
}

/**
 * Drains pending or retriable inbound events from SQLite / PostgreSQL
 * Runs on startup and periodically in background
 */
export async function drainPendingInboundQueue(apiKey) {
  try {
    const pending = await getPendingInboundEvents(20);
    if (!pending || pending.length === 0) return 0;

    console.log(`🔄 [Inbound Queue]: Processing ${pending.length} pending inbound event(s)...`);
    let processed = 0;

    for (const record of pending) {
      try {
        await processInboundEvent(record, apiKey);
        processed++;
      } catch (err) {
        console.error(`❌ [Inbound Queue Error] Event ${record.event_id}:`, err.message);
        // Exponential backoff or max attempts is handled in updateInboundEventStatus
      }
    }

    return processed;
  } catch (err) {
    console.error('[Inbound Queue Error]:', err.message);
    return 0;
  }
}
