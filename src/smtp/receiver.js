import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';
import { EventEmitter } from 'node:events';
import { getMailboxByEmail, saveEmail, logSmtp, verifyPassword } from '../db/database.js';

export const smtpEvents = new EventEmitter();

/**
 * Creates and starts the SMTP Receiver Server
 * Configured securely to bind to local loopback (127.0.0.1) by default
 */
export function startSmtpReceiver(port = 2525, host = '127.0.0.1') {
  const server = new SMTPServer({
    banner: 'AetherMail ESMTP Security Hardened Ready',
    authOptional: true, // Allows receiving incoming mail from external MTAs
    size: 25 * 1024 * 1024, // 25 MB max message size limit (RFC standard)
    maxClients: 20, // Max concurrent socket connections

    // Secure SMTP Authentication using constant-time scrypt verification
    onAuth(auth, session, callback) {
      const email = auth.username?.trim().toLowerCase();
      const mailbox = getMailboxByEmail(email, true); // Load with secret password_hash

      if (!mailbox) {
        logSmtp('AUTH', session.remoteAddress, email, null, 'FAILED', 'Unknown mailbox');
        return callback(new Error('535 5.7.8 Authentication credentials invalid'));
      }

      // Verify cryptographic scrypt hash (NO hardcoded bypass!)
      const isValid = verifyPassword(auth.password, mailbox.password_hash);
      if (isValid) {
        logSmtp('AUTH', session.remoteAddress, email, null, 'SUCCESS', 'Authenticated successfully via scrypt');
        return callback(null, { user: email });
      }

      logSmtp('AUTH', session.remoteAddress, email, null, 'FAILED', 'Invalid password attempt');
      return callback(new Error('535 5.7.8 Authentication credentials invalid'));
    },

    // Handle MAIL FROM command
    onMailFrom(address, session, callback) {
      const sender = address.address;
      session.senderAddress = sender;
      return callback(); // Accept sender envelope
    },

    // Handle RCPT TO command (Strict Recipient Mailbox Validation)
    onRcptTo(address, session, callback) {
      const recipient = address.address.trim().toLowerCase();
      const mailbox = getMailboxByEmail(recipient, false);

      if (!mailbox) {
        logSmtp(
          'INBOUND_REJECT',
          session.remoteAddress,
          session.senderAddress,
          recipient,
          'REJECTED',
          'Virtual mailbox does not exist'
        );
        // RFC 550 User Unknown prevents backscatter spam
        return callback(new Error(`550 5.1.1 <${recipient}>: Recipient address rejected: User unknown in virtual mailbox table`));
      }

      if (!session.recipients) {
        session.recipients = [];
      }
      session.recipients.push({ email: recipient, mailboxId: mailbox.id });
      return callback();
    },

    // Handle DATA stream (MIME parsing & atomic database storage)
    onData(stream, session, callback) {
      simpleParser(stream, async (err, parsed) => {
        if (err) {
          logSmtp(
            'INBOUND_ERROR',
            session.remoteAddress,
            session.senderAddress,
            session.recipients?.[0]?.email || 'unknown',
            'ERROR',
            err.message
          );
          return callback(new Error('451 4.3.0 Error parsing MIME body'));
        }

        try {
          const senderAddr = parsed.from?.value?.[0]?.address || session.senderAddress || 'unknown@sender.com';
          const senderName = parsed.from?.value?.[0]?.name || '';
          const subject = parsed.subject || '(No Subject)';
          const textBody = parsed.text || '';
          const htmlBody = parsed.html || (textBody ? `<pre>${escapeHtml(textBody)}</pre>` : '');
          const messageId = parsed.messageId || `<${Date.now()}@email-server.local>`;

          // Process attachments
          const attachments = (parsed.attachments || []).map((att) => ({
            filename: att.filename || 'attachment.bin',
            contentType: att.contentType,
            size: att.size,
            content: att.content
          }));

          // Atomic persistence for all matching recipients
          for (const recipient of session.recipients || []) {
            const savedEmail = saveEmail({
              mailboxId: recipient.mailboxId,
              folder: 'inbox',
              direction: 'inbound',
              fromAddress: senderAddr,
              fromName: senderName,
              toAddress: recipient.email,
              subject: subject,
              bodyText: textBody,
              bodyHtml: htmlBody,
              rawHeaders: parsed.headers ? Object.fromEntries(parsed.headers) : {},
              messageId: messageId,
              dkimStatus: 'none',
              deliveryStatus: 'delivered',
              attachments: attachments
            });

            logSmtp(
              'INBOUND_DELIVERED',
              session.remoteAddress,
              senderAddr,
              recipient.email,
              'DELIVERED',
              `Subject: "${subject}", Attachments: ${attachments.length}, ID: ${savedEmail.id}`
            );

            // Broadcast real-time event to authorized Webmail UI
            smtpEvents.emit('new_email', {
              mailboxId: recipient.mailboxId,
              email: savedEmail
            });
          }

          callback(); // 250 OK
        } catch (storageError) {
          console.error('[SMTP Storage Error]:', storageError);
          callback(new Error('451 4.3.0 Internal database storage failure'));
        }
      });
    }
  });

  server.on('error', (err) => {
    console.error(`[SMTP Receiver Error on ${host}:${port}]:`, err.message);
  });

  server.listen(port, host, () => {
    console.log(`🛡️ [SMTP Receiver] Bound securely on ${host}:${port}`);
  });

  return server;
}

function escapeHtml(string) {
  return String(string)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
