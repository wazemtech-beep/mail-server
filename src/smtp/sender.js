import nodemailer from 'nodemailer';
import dns from 'node:dns';
import { 
  getMailboxByEmail as sqliteGetMailboxByEmail, 
  getDomainById as sqliteGetDomainById, 
  saveEmail as sqliteSaveEmail, 
  createQueueItem as sqliteCreateQueueItem, 
  updateQueueItem as sqliteUpdateQueueItem, 
  logSmtp as sqliteLogSmtp 
} from '../db/database.js';
import {
  getPgPool,
  pgGetMailboxByEmail,
  pgGetDomainById,
  pgSaveEmail,
  pgCreateQueueItem,
  pgUpdateQueueItem,
  pgLogSmtp
} from '../db/postgres.js';
import { smtpEvents } from './receiver.js';

const getMailboxByEmail = async (em, s) => getPgPool() ? await pgGetMailboxByEmail(em, s) : sqliteGetMailboxByEmail(em, s);
const getDomainById = async (id, s) => getPgPool() ? await pgGetDomainById(id, s) : sqliteGetDomainById(id, s);
const saveEmail = async (opts) => getPgPool() ? await pgSaveEmail(opts) : sqliteSaveEmail(opts);
const createQueueItem = async (...args) => getPgPool() ? await pgCreateQueueItem(...args) : sqliteCreateQueueItem(...args);
const updateQueueItem = async (...args) => getPgPool() ? await pgUpdateQueueItem(...args) : sqliteUpdateQueueItem(...args);
const logSmtp = async (...args) => getPgPool() ? await pgLogSmtp(...args) : sqliteLogSmtp(...args);

// Resend Relay Configuration for Clean IP Delivery
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';

try {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
} catch (e) {
  console.warn('[DNS Config Warn]:', e.message);
}

/**
 * Robust MX Resolver with DNS-over-HTTPS (DoH) fallback
 */
async function resolveMxRecords(domain) {
  try {
    dns.setServers(['8.8.8.8', '1.1.1.1']);
    const records = await dns.promises.resolveMx(domain);
    if (records && records.length > 0) {
      records.sort((a, b) => a.priority - b.priority);
      return records;
    }
  } catch (err) {
    console.warn(`[DNS UDP fallback]: Failed to resolve MX for ${domain} (${err.code || err.message}). Switching to DoH...`);
  }

  try {
    const res = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=MX`);
    const data = await res.json();
    if (data.Answer && data.Answer.length > 0) {
      const records = data.Answer.map((a) => {
        const parts = a.data.trim().split(/\s+/);
        return {
          priority: parseInt(parts[0], 10) || 10,
          exchange: (parts[1] || parts[0]).replace(/\.$/, '')
        };
      });
      records.sort((a, b) => a.priority - b.priority);
      return records;
    }
  } catch (dohErr) {
    console.error(`[DNS DoH Error]:`, dohErr.message);
  }

  throw new Error(`No MX mail exchangers found for domain ${domain}`);
}

/**
 * Dispatches an email with real DKIM signing, local routing, and clean relay / MX resolution
 */
export async function sendEmail({
  fromEmail,
  toEmail,
  subject,
  bodyText,
  bodyHtml,
  attachments = []
}) {
  const normalizedFrom = fromEmail.trim().toLowerCase();
  const normalizedTo = toEmail.trim().toLowerCase();

  // Load sender mailbox with secrets
  const senderMailbox = await getMailboxByEmail(normalizedFrom, true);
  if (!senderMailbox) {
    throw new Error(`Sender mailbox ${fromEmail} does not exist`);
  }

  // Load domain secrets for DKIM
  const domain = await getDomainById(senderMailbox.domain_id, true);
  if (!domain) {
    throw new Error('Sender domain not configured');
  }

  const messageId = `<${Date.now()}.${Math.random().toString(36).substring(2, 9)}@${domain.name}>`;

  // 1. Save copy into Sender's "sent" folder
  const sentCopy = await saveEmail({
    mailboxId: senderMailbox.id,
    folder: 'sent',
    direction: 'outbound',
    fromAddress: senderMailbox.email,
    fromName: senderMailbox.name,
    toAddress: normalizedTo,
    subject: subject || '(No Subject)',
    bodyText: bodyText || '',
    bodyHtml: bodyHtml || bodyText || '',
    messageId: messageId,
    dkimStatus: 'signed',
    deliveryStatus: 'processing',
    attachments: attachments
  });

  // 2. CHECK IF RECIPIENT IS LOCAL TO OUR SERVER
  const recipientMailbox = await getMailboxByEmail(normalizedTo, false);
  if (recipientMailbox) {
    const receivedEmail = await saveEmail({
      mailboxId: recipientMailbox.id,
      folder: 'inbox',
      direction: 'inbound',
      fromAddress: senderMailbox.email,
      fromName: senderMailbox.name,
      toAddress: recipientMailbox.email,
      subject: subject || '(No Subject)',
      bodyText: bodyText || '',
      bodyHtml: bodyHtml || bodyText || '',
      messageId: messageId,
      dkimStatus: 'verified_internal',
      deliveryStatus: 'delivered',
      attachments: attachments
    });

    await logSmtp(
      'LOCAL_DELIVERY',
      '127.0.0.1',
      senderMailbox.email,
      recipientMailbox.email,
      'DELIVERED',
      `Internal routing to mailbox ID ${recipientMailbox.id}. Subject: "${subject}"`
    );

    smtpEvents.emit('new_email', {
      mailboxId: recipientMailbox.id,
      email: receivedEmail
    });

    return {
      success: true,
      mode: 'internal',
      deliveryStatus: 'delivered',
      sentEmailId: sentCopy.id,
      messageId: messageId
    };
  }

  // 3. EXTERNAL DELIVERY
  const recipientDomain = normalizedTo.split('@')[1];
  if (!recipientDomain) {
    throw new Error(`Invalid recipient email format: ${normalizedTo}`);
  }

  const queueId = await createQueueItem(senderMailbox.id, normalizedTo, subject, RESEND_API_KEY ? 'resend.com' : 'direct-mx');

  // Option A: If Resend Relay API Key is configured, use clean IP relay
  if (RESEND_API_KEY) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: `${senderMailbox.name} <${senderMailbox.email}>`,
          to: [normalizedTo],
          subject: subject,
          text: bodyText,
          html: bodyHtml || (bodyText ? `<pre>${bodyText}</pre>` : ''),
          headers: {
            'X-Entity-Ref-ID': messageId
          }
        })
      });

      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.message || data.error || JSON.stringify(data));
      }

      await updateQueueItem(queueId, 'delivered');
      await logSmtp(
        'OUTBOUND_RELAY',
        'api.resend.com',
        senderMailbox.email,
        normalizedTo,
        'DELIVERED',
        `Dispatched via Resend Relay. ID: ${data.id}`
      );

      return {
        success: true,
        mode: 'external_relay_delivered',
        relay: 'Resend Clean Delivery Network',
        messageId: data.id,
        sentEmailId: sentCopy.id
      };
    } catch (relayError) {
      await updateQueueItem(queueId, 'failed', relayError.message);
      await logSmtp(
        'OUTBOUND_RELAY',
        'api.resend.com',
        senderMailbox.email,
        normalizedTo,
        'FAILED',
        `Relay dispatch error: ${relayError.message}`
      );
      throw new Error(`Outbound Relay Error: ${relayError.message}`);
    }
  }

  // Option B: Direct MX Delivery fallback (used when deployed on VPS with clean IP & PTR)
  let mxHost = null;
  try {
    const mxRecords = await resolveMxRecords(recipientDomain);
    mxHost = mxRecords[0].exchange;

    const transporter = nodemailer.createTransport({
      host: mxHost,
      port: 25,
      secure: false,
      connectionTimeout: 12000,
      greetingTimeout: 8000,
      tls: { rejectUnauthorized: false },
      dkim: {
        domainName: domain.name,
        keySelector: domain.dkim_selector,
        privateKey: domain.dkim_private_key
      }
    });

    const info = await transporter.sendMail({
      from: `"${senderMailbox.name}" <${senderMailbox.email}>`,
      to: normalizedTo,
      subject: subject,
      text: bodyText,
      html: bodyHtml || (bodyText ? `<pre>${bodyText}</pre>` : ''),
      messageId: messageId
    });

    updateQueueItem(queueId, 'delivered');
    logSmtp('OUTBOUND_MX', mxHost, senderMailbox.email, normalizedTo, 'DELIVERED', `Delivered via MX ${mxHost}. Response: ${info.response}`);

    return {
      success: true,
      mode: 'external_mx_delivered',
      mxHost: mxHost,
      response: info.response,
      messageId: messageId
    };
  } catch (deliveryError) {
    updateQueueItem(queueId, 'failed', deliveryError.message);
    logSmtp('OUTBOUND_MX', mxHost || 'DNS_LOOKUP', senderMailbox.email, normalizedTo, 'FAILED', `MX delivery error: ${deliveryError.message}`);
    return {
      success: false,
      mode: 'external_mx_attempted',
      mxHost: mxHost,
      error: deliveryError.message
    };
  }
}
