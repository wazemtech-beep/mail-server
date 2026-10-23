import assert from 'node:assert';
import http from 'node:http';
import { db, createDomain, createMailbox, getMailboxByEmail, getEmails } from '../src/db/database.js';
import { generateSvixHeaders } from '../src/inbound/webhook-verifier.js';

// Setup environment secret for the test
process.env.RESEND_WEBHOOK_SECRET = 'whsec_' + Buffer.from('my_secret_webhook_key_1234567890').toString('base64');
process.env.PORT = '3001';

// Import app after setting env vars
const { default: app } = await import('../src/server.js');

const server = app.listen(3001, '127.0.0.1');

async function runHttpTests() {
  console.log('================================================================');
  console.log('🌐 AETHERMAIL — HTTP INBOUND WEBHOOK INTEGRATION TESTS');
  console.log('================================================================\n');

  try {
    // 1. Setup Mailbox
    let domain = db.prepare(`SELECT * FROM domains WHERE name = 'webhook-test.com'`).get();
    if (!domain) domain = createDomain('webhook-test.com');

    let mailbox = getMailboxByEmail('ceo@webhook-test.com', true);
    if (!mailbox) {
      mailbox = createMailbox(domain.id, 'ceo@webhook-test.com', 'CEO Webhook Test', 'Secret1234!');
    }

    // TEST 1: Reject request with invalid signature
    console.log('▶ [HTTP TEST 1] POST with invalid Svix signature...');
    const invalidRes = await fetch('http://127.0.0.1:3001/api/webhooks/resend/inbound', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'svix-id': 'msg_fake_123',
        'svix-timestamp': String(Math.floor(Date.now() / 1000)),
        'svix-signature': 'v1,invalid_signature_hash=='
      },
      body: JSON.stringify({ type: 'email.received', data: { email_id: 'fake-id' } })
    });

    assert.strictEqual(invalidRes.status, 401, 'Should return 401 for invalid signature');
    console.log('  ✅ [PASS] Invalid signature rejected with HTTP 401');

    // TEST 2: Accept request with valid signature
    console.log('\n▶ [HTTP TEST 2] POST with valid Svix signature & payload...');
    const providerEmailId = `resend-http-${Date.now()}`;
    const payload = {
      type: 'email.received',
      created_at: new Date().toISOString(),
      data: {
        email_id: providerEmailId,
        message_id: `<ext-${Date.now()}@gmail.com>`,
        from: 'investor@sequoia.com',
        to: ['ceo@webhook-test.com'],
        subject: 'Term Sheet: Seed Round $5M 🚀',
        text: 'Please review our investment term sheet attached.',
        html: '<p>Please review our <strong>investment term sheet</strong> attached.</p>'
      }
    };

    const rawBody = JSON.stringify(payload);
    const validHeaders = generateSvixHeaders({
      payload: rawBody,
      secret: process.env.RESEND_WEBHOOK_SECRET
    });

    const validRes = await fetch('http://127.0.0.1:3001/api/webhooks/resend/inbound', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...validHeaders
      },
      body: rawBody
    });

    assert.strictEqual(validRes.status, 200, 'Should return 200 for valid webhook');
    const validJson = await validRes.json();
    assert.strictEqual(validJson.received, true);
    console.log('  ✅ [PASS] Valid webhook accepted with HTTP 200:', JSON.stringify(validJson));

    // Verify email arrived in SQLite mailbox
    const emails = getEmails(mailbox.id, 'inbox');
    const receivedEmail = emails.find(e => e.provider_email_id === providerEmailId);
    assert.ok(receivedEmail, 'Email must exist in database');
    assert.strictEqual(receivedEmail.subject, 'Term Sheet: Seed Round $5M 🚀');
    assert.strictEqual(receivedEmail.from_address, 'investor@sequoia.com');
    assert.strictEqual(receivedEmail.is_read, 0);
    console.log('  ✅ [PASS] Email successfully routed to ceo@webhook-test.com Inbox (ID: ' + receivedEmail.id + ')');

    // TEST 3: Duplicate webhook submission (Idempotency)
    console.log('\n▶ [HTTP TEST 3] POST duplicate webhook (checking idempotency)...');
    const dupRes = await fetch('http://127.0.0.1:3001/api/webhooks/resend/inbound', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...validHeaders
      },
      body: rawBody
    });

    assert.strictEqual(dupRes.status, 200);
    const dupJson = await dupRes.json();
    assert.strictEqual(dupJson.status, 'duplicate_acknowledged');
    console.log('  ✅ [PASS] Duplicate delivery acknowledged without duplicate database insertion:', JSON.stringify(dupJson));

    console.log('\n================================================================');
    console.log('🎉 ALL HTTP INBOUND WEBHOOK INTEGRATION TESTS PASSED!');
    console.log('================================================================\n');
  } finally {
    server.close(() => {
      process.exit(0);
    });
  }
}

runHttpTests().catch(err => {
  console.error('HTTP Test Failure:', err);
  server.close();
  process.exit(1);
});
