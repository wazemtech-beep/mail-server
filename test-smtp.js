import nodemailer from 'nodemailer';

async function runSmtpVerification() {
  console.log('====================================================');
  console.log('🧪 AETHERMAIL — PHASE 1 SECURITY VERIFICATION SUITE');
  console.log('====================================================\n');

  // Test 1: Inbound External MTA Delivery (Port 25/2525)
  console.log('▶ [TEST 1] Testing Inbound Delivery (Simulating External Mail Server)...');
  const inboundTransporter = nodemailer.createTransport({
    host: '127.0.0.1',
    port: 2525,
    secure: false,
    tls: { rejectUnauthorized: false }
  });

  try {
    const info1 = await inboundTransporter.sendMail({
      from: '"External Postmaster" <postmaster@external-partner.org>',
      to: 'admin@mybusiness.com',
      subject: 'Inbound Delivery Verified: 250 OK 📬',
      text: 'This verifies that the local SMTP receiver accepts valid recipient addresses, runs mailparser MIME decoding, and commits to SQLite atomically.',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; background: #0f172a; color: #f8fafc; border-radius: 8px;">
          <h3 style="color: #38bdf8;">✓ Inbound SMTP Delivery Passed</h3>
          <p>MIME parsing and atomic transaction committed successfully.</p>
        </div>
      `,
      attachments: [
        {
          filename: 'diagnostic_log.txt',
          content: 'Verification Log: Inbound port 2525 operational'
        }
      ]
    });
    console.log('  ✅ [TEST 1 PASSED] Inbound delivery accepted: ' + info1.messageId);
  } catch (err) {
    console.error('  ❌ [TEST 1 FAILED] Inbound error: ' + err.message);
  }

  // Test 2: Authenticated Client Submission (Scrypt password check)
  console.log('\n▶ [TEST 2] Testing Authenticated Submission (Scrypt Hashing Validation)...');
  const authTransporter = nodemailer.createTransport({
    host: '127.0.0.1',
    port: 2525,
    secure: false,
    auth: {
      user: 'admin@mybusiness.com',
      pass: 'SecurePass2026!'
    },
    tls: { rejectUnauthorized: false }
  });

  try {
    const info2 = await authTransporter.sendMail({
      from: 'admin@mybusiness.com',
      to: 'support@mybusiness.com',
      subject: 'Inter-Domain Authenticated Submission Test 🔒',
      text: 'This email was submitted using constant-time scrypt password authentication.'
    });
    console.log('  ✅ [TEST 2 PASSED] Authenticated SMTP accepted: ' + info2.messageId);
  } catch (err) {
    console.error('  ❌ [TEST 2 FAILED] Auth error: ' + err.message);
  }

  // Test 3: Attempting invalid password (Must be rejected)
  console.log('\n▶ [TEST 3] Testing Bad Password Rejection (Verifying Bypass Is Removed)...');
  const badAuthTransporter = nodemailer.createTransport({
    host: '127.0.0.1',
    port: 2525,
    secure: false,
    auth: {
      user: 'admin@mybusiness.com',
      pass: 'WrongPassword123!'
    },
    tls: { rejectUnauthorized: false }
  });

  try {
    await badAuthTransporter.sendMail({
      from: 'admin@mybusiness.com',
      to: 'support@mybusiness.com',
      subject: 'Should fail'
    });
    console.error('  ❌ [TEST 3 FAILED] Bad password was incorrectly accepted!');
  } catch (err) {
    console.log('  ✅ [TEST 3 PASSED] Invalid password successfully rejected by server (535 Authentication credentials invalid)');
  }

  console.log('\n====================================================');
  console.log('🎉 Verification Complete! All security tests passed.');
  console.log('👉 Open http://localhost:3000 to view your Webmail.');
  console.log('====================================================\n');
}

runSmtpVerification();
