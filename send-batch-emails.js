import { createMailbox, getMailboxByEmail } from './src/db/database.js';
import { sendEmail } from './src/smtp/sender.js';

// Mailbox and email batch list
const batch = [
  {
    fromEmail: 'fahad@wazemtech.com',
    fromName: 'Fahad Hussain',
    toEmail: 'fahadhussain0282@gmail.com',
    subject: 'Welcome to WazemTech Email Network 🚀',
    bodyText: 'Assalam-o-Alaikum Fahad,\n\nThis is a verified test email sent from fahad@wazemtech.com using our custom AetherMail email platform.\n\nEverything is operational!',
    bodyHtml: `
      <div style="font-family: Arial, sans-serif; padding: 24px; background: #0f172a; color: #f8fafc; border-radius: 12px; max-width: 600px; border: 1px solid #334155;">
        <h2 style="color: #38bdf8; margin-top: 0;">Assalam-o-Alaikum Fahad! 🚀</h2>
        <p style="color: #e2e8f0; font-size: 15px; line-height: 1.6;">
          This email was dispatched from your official custom mailbox: <strong>fahad@wazemtech.com</strong>.
        </p>
        <div style="background: #1e293b; padding: 16px; border-radius: 8px; margin: 16px 0; border-left: 4px solid #38bdf8;">
          <p style="margin: 0;"><strong>Sender:</strong> fahad@wazemtech.com</p>
          <p style="margin: 6px 0 0 0;"><strong>Recipient:</strong> fahadhussain0282@gmail.com</p>
          <p style="margin: 6px 0 0 0;"><strong>Infrastructure:</strong> WazemTech Self-Hosted Email Platform</p>
        </div>
        <p style="color: #94a3b8; font-size: 13px; margin: 0;">Verified 2048-bit DKIM & SPF authenticated message.</p>
      </div>
    `
  },
  {
    fromEmail: 'waliha@wazemtech.com',
    fromName: 'Waliha Idrees',
    toEmail: 'walihaidrees0987@gmail.com',
    subject: 'Greetings from Waliha @ WazemTech 📬',
    bodyText: 'Assalam-o-Alaikum Waliha,\n\nThis is a test email sent from waliha@wazemtech.com through our custom email server platform.\n\nAll systems are working smoothly!',
    bodyHtml: `
      <div style="font-family: Arial, sans-serif; padding: 24px; background: #0f172a; color: #f8fafc; border-radius: 12px; max-width: 600px; border: 1px solid #334155;">
        <h2 style="color: #38bdf8; margin-top: 0;">Assalam-o-Alaikum Waliha! 📬</h2>
        <p style="color: #e2e8f0; font-size: 15px; line-height: 1.6;">
          This message is successfully transmitted from your custom mailbox: <strong>waliha@wazemtech.com</strong>.
        </p>
        <div style="background: #1e293b; padding: 16px; border-radius: 8px; margin: 16px 0; border-left: 4px solid #38bdf8;">
          <p style="margin: 0;"><strong>Sender:</strong> waliha@wazemtech.com</p>
          <p style="margin: 6px 0 0 0;"><strong>Recipient:</strong> walihaidrees0987@gmail.com</p>
          <p style="margin: 6px 0 0 0;"><strong>Status:</strong> Active & Verified</p>
        </div>
        <p style="color: #94a3b8; font-size: 13px; margin: 0;">Verified 2048-bit DKIM & SPF authenticated message.</p>
      </div>
    `
  },
  {
    fromEmail: 'yasir@wazemtech.com',
    fromName: 'Yasir - YJ Tech',
    toEmail: 'hello.yjtech@gmail.com',
    subject: 'Hello from Yasir @ WazemTech ⚡',
    bodyText: 'Hello YJ Tech Team,\n\nThis is a verified test email sent from yasir@wazemtech.com.\n\nOur custom email engine is 100% active!',
    bodyHtml: `
      <div style="font-family: Arial, sans-serif; padding: 24px; background: #0f172a; color: #f8fafc; border-radius: 12px; max-width: 600px; border: 1px solid #334155;">
        <h2 style="color: #38bdf8; margin-top: 0;">Hello YJ Tech Team! ⚡</h2>
        <p style="color: #e2e8f0; font-size: 15px; line-height: 1.6;">
          This email was dispatched from <strong>yasir@wazemtech.com</strong> via our custom email server engine.
        </p>
        <div style="background: #1e293b; padding: 16px; border-radius: 8px; margin: 16px 0; border-left: 4px solid #38bdf8;">
          <p style="margin: 0;"><strong>Sender:</strong> yasir@wazemtech.com</p>
          <p style="margin: 6px 0 0 0;"><strong>Recipient:</strong> hello.yjtech@gmail.com</p>
          <p style="margin: 6px 0 0 0;"><strong>Delivery:</strong> Authenticated Clean IP Network</p>
        </div>
        <p style="color: #94a3b8; font-size: 13px; margin: 0;">Verified 2048-bit DKIM & SPF authenticated message.</p>
      </div>
    `
  },
  {
    fromEmail: 'waseem@wazemtech.com',
    fromName: 'Waseem - WazemTech',
    toEmail: 'waseem@addiztech.com',
    subject: 'Partnership & Technical Update from WazemTech 🌐',
    bodyText: 'Assalam-o-Alaikum Waseem,\n\nThis is an official communication from waseem@wazemtech.com to waseem@addiztech.com.\n\nOur email infrastructure and DKIM authentication are fully operational.',
    bodyHtml: `
      <div style="font-family: Arial, sans-serif; padding: 24px; background: #0f172a; color: #f8fafc; border-radius: 12px; max-width: 600px; border: 1px solid #334155;">
        <h2 style="color: #38bdf8; margin-top: 0;">Assalam-o-Alaikum Waseem! 🌐</h2>
        <p style="color: #e2e8f0; font-size: 15px; line-height: 1.6;">
          This official email was transmitted from <strong>waseem@wazemtech.com</strong> to <strong>waseem@addiztech.com</strong>.
        </p>
        <div style="background: #1e293b; padding: 16px; border-radius: 8px; margin: 16px 0; border-left: 4px solid #38bdf8;">
          <p style="margin: 0;"><strong>Sender:</strong> waseem@wazemtech.com</p>
          <p style="margin: 6px 0 0 0;"><strong>Recipient:</strong> waseem@addiztech.com</p>
          <p style="margin: 6px 0 0 0;"><strong>Domain:</strong> wazemtech.com</p>
        </div>
        <p style="color: #94a3b8; font-size: 13px; margin: 0;">Verified 2048-bit DKIM & SPF authenticated message.</p>
      </div>
    `
  }
];

async function runBatch() {
  console.log('====================================================');
  console.log('🚀 AETHERMAIL — BATCH DISPATCH IN PROGRESS');
  console.log('====================================================\n');

  const results = [];

  for (const item of batch) {
    console.log(`▶ Preparing mailbox: ${item.fromEmail}...`);
    // Ensure mailbox exists in database
    let mailbox = getMailboxByEmail(item.fromEmail, true);
    if (!mailbox) {
      mailbox = createMailbox(2, item.fromEmail, item.fromName, 'SecurePass2026!');
      console.log(`  ✓ Created new mailbox: ${item.fromEmail}`);
    }

    console.log(`  Sending: ${item.fromEmail} -> ${item.toEmail}...`);
    try {
      const res = await sendEmail({
        fromEmail: item.fromEmail,
        toEmail: item.toEmail,
        subject: item.subject,
        bodyText: item.bodyText,
        bodyHtml: item.bodyHtml
      });

      console.log(`  ✅ DELIVERED! Message ID: ${res.messageId}`);
      results.push({
        from: item.fromEmail,
        to: item.toEmail,
        status: 'SUCCESS',
        messageId: res.messageId
      });
    } catch (err) {
      console.error(`  ❌ FAILED: ${err.message}`);
      results.push({
        from: item.fromEmail,
        to: item.toEmail,
        status: 'FAILED',
        error: err.message
      });
    }
    console.log('----------------------------------------------------');
  }

  console.log('\n📊 FINAL BATCH SUMMARY:');
  console.table(results);
}

runBatch().catch(console.error);
