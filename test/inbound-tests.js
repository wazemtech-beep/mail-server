import assert from 'node:assert';
import crypto from 'node:crypto';
import { 
  db, 
  createDomain, 
  createMailbox, 
  getMailboxByEmail, 
  getEmails, 
  recordInboundEvent, 
  getInboundEventById, 
  getPendingInboundEvents, 
  updateInboundEventStatus 
} from '../src/db/database.js';
import { verifyResendWebhook, generateSvixHeaders } from '../src/inbound/webhook-verifier.js';
import { processInboundEvent, drainPendingInboundQueue, extractEmailAddress } from '../src/inbound/processor.js';

const TEST_SECRET = 'whsec_' + Buffer.from('test_secret_for_automated_verification_12345').toString('base64');

async function runTestSuite() {
  console.log('================================================================');
  console.log('🧪 AETHERMAIL — COMPREHENSIVE INBOUND EMAIL VERIFICATION SUITE');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  function report(name, success, detail = '') {
    if (success) {
      console.log(`  ✅ [PASS] ${name}`);
      if (detail) console.log(`     └─ ${detail}`);
      passed++;
    } else {
      console.error(`  ❌ [FAIL] ${name}`);
      if (detail) console.error(`     └─ ${detail}`);
      failed++;
    }
  }

  // Setup Test Domain & Mailboxes
  console.log('▶ Setting up test domain & virtual mailboxes...');
  let testDomain = db.prepare(`SELECT * FROM domains WHERE name = 'inbound-test.com'`).get();
  if (!testDomain) {
    testDomain = createDomain('inbound-test.com');
  }

  let mailboxA = getMailboxByEmail('alice@inbound-test.com', true);
  if (!mailboxA) {
    mailboxA = createMailbox(testDomain.id, 'alice@inbound-test.com', 'Alice Test', 'Password123!');
  }

  let mailboxB = getMailboxByEmail('bob@inbound-test.com', true);
  if (!mailboxB) {
    mailboxB = createMailbox(testDomain.id, 'bob@inbound-test.com', 'Bob Test', 'Password123!');
  }

  // --------------------------------------------------------------------------
  // TEST 1: Valid Webhook Signature Verification
  // --------------------------------------------------------------------------
  console.log('\n▶ [TEST 1] Testing Valid Svix Webhook Signature...');
  try {
    const payload = JSON.stringify({ type: 'email.received', data: { email_id: 'test-123' } });
    const headers = generateSvixHeaders({ payload, secret: TEST_SECRET });
    const res = verifyResendWebhook({ rawBody: payload, headers, secret: TEST_SECRET });
    assert.strictEqual(res.valid, true);
    report('Valid Svix Webhook Signature Verified', true, 'HMAC-SHA256 signature matched expected digest');
  } catch (err) {
    report('Valid Svix Webhook Signature Verified', false, err.message);
  }

  // --------------------------------------------------------------------------
  // TEST 2: Invalid Webhook Signature Rejection
  // --------------------------------------------------------------------------
  console.log('\n▶ [TEST 2] Testing Invalid Webhook Signature Rejection...');
  try {
    const payload = JSON.stringify({ type: 'email.received', data: { email_id: 'tampered-data' } });
    const headers = generateSvixHeaders({ payload, secret: TEST_SECRET });
    // Tamper with payload
    const tamperedPayload = JSON.stringify({ type: 'email.received', data: { email_id: 'HACKED' } });
    const res = verifyResendWebhook({ rawBody: tamperedPayload, headers, secret: TEST_SECRET });
    assert.strictEqual(res.valid, false);
    report('Tampered/Invalid Webhook Rejected', true, `Correctly rejected: ${res.error}`);
  } catch (err) {
    report('Tampered/Invalid Webhook Rejected', false, err.message);
  }

  // --------------------------------------------------------------------------
  // TEST 3: Duplicate Webhook Delivery (Idempotency)
  // --------------------------------------------------------------------------
  console.log('\n▶ [TEST 3] Testing Idempotent Delivery (No Duplicate Inbound Emails)...');
  try {
    const providerEmailId = `resend-idmp-${Date.now()}`;
    const initialEmails = getEmails(mailboxA.id, 'inbox').length;

    const eventRecord = {
      id: 99901,
      event_id: `evt_idmp_${Date.now()}`,
      event_type: 'email.received',
      payload: {
        type: 'email.received',
        data: {
          email_id: providerEmailId,
          from: 'external-sender@gmail.com',
          to: ['alice@inbound-test.com'],
          subject: 'Idempotency Test Email',
          text: 'Body text',
          html: '<p>Body HTML</p>'
        }
      }
    };

    // First Processing
    await processInboundEvent(eventRecord, null);
    const countAfterFirst = getEmails(mailboxA.id, 'inbox').length;
    assert.strictEqual(countAfterFirst, initialEmails + 1, 'First delivery should insert 1 email');

    // Duplicate Processing (Same providerEmailId)
    await processInboundEvent(eventRecord, null);
    const countAfterSecond = getEmails(mailboxA.id, 'inbox').length;
    assert.strictEqual(countAfterSecond, initialEmails + 1, 'Duplicate webhook should NOT create second email');

    report('Idempotent Delivery Guaranteed', true, `Emails before: ${initialEmails}, after 1st: ${countAfterFirst}, after 2nd: ${countAfterSecond}`);
  } catch (err) {
    report('Idempotent Delivery Guaranteed', false, err.message);
  }

  // --------------------------------------------------------------------------
  // TEST 4: Unknown Recipient Handling (No Ghost Mailboxes)
  // --------------------------------------------------------------------------
  console.log('\n▶ [TEST 4] Testing Unknown Recipient Handling...');
  try {
    const ghostEmail = 'nonexistent-ghost-user@inbound-test.com';
    const beforeMailboxCheck = getMailboxByEmail(ghostEmail);
    assert.strictEqual(beforeMailboxCheck, null);

    const eventRecord = {
      id: 99902,
      event_id: `evt_ghost_${Date.now()}`,
      event_type: 'email.received',
      payload: {
        type: 'email.received',
        data: {
          email_id: `resend-ghost-${Date.now()}`,
          from: 'external@yahoo.com',
          to: [ghostEmail],
          subject: 'Message to Nowhere',
          text: 'Hello nobody'
        }
      }
    };

    const result = await processInboundEvent(eventRecord, null);
    assert.strictEqual(result.deliveredCount, 0, 'Should deliver to 0 mailboxes');
    const afterMailboxCheck = getMailboxByEmail(ghostEmail);
    assert.strictEqual(afterMailboxCheck, null, 'Must NOT create ghost mailboxes');

    report('Unknown Recipient Safely Rejected/Logged', true, 'Delivered count: 0, no unauthorized mailboxes created');
  } catch (err) {
    report('Unknown Recipient Safely Rejected/Logged', false, err.message);
  }

  // --------------------------------------------------------------------------
  // TEST 5: Multiple Recipients Routing
  // --------------------------------------------------------------------------
  console.log('\n▶ [TEST 5] Testing Multiple Recipients Routing...');
  try {
    const providerEmailId = `resend-multi-${Date.now()}`;
    const aliceBefore = getEmails(mailboxA.id, 'inbox').length;
    const bobBefore = getEmails(mailboxB.id, 'inbox').length;

    const eventRecord = {
      id: 99903,
      event_id: `evt_multi_${Date.now()}`,
      event_type: 'email.received',
      payload: {
        type: 'email.received',
        data: {
          email_id: providerEmailId,
          from: 'partner@corporation.org',
          to: ['alice@inbound-test.com', 'bob@inbound-test.com'],
          subject: 'Multi-Tenant Company Announcement',
          text: 'Hello team Alice and Bob!'
        }
      }
    };

    const result = await processInboundEvent(eventRecord, null);
    assert.strictEqual(result.deliveredCount, 2, 'Should deliver to both recipients');

    const aliceAfter = getEmails(mailboxA.id, 'inbox').length;
    const bobAfter = getEmails(mailboxB.id, 'inbox').length;

    assert.strictEqual(aliceAfter, aliceBefore + 1, 'Alice must receive 1 copy');
    assert.strictEqual(bobAfter, bobBefore + 1, 'Bob must receive 1 copy');

    report('Multiple Recipients Correctly Routed', true, `Delivered to both Alice (ID: ${mailboxA.id}) and Bob (ID: ${mailboxB.id})`);
  } catch (err) {
    report('Multiple Recipients Correctly Routed', false, err.message);
  }

  // --------------------------------------------------------------------------
  // TEST 6: Plain-Text and HTML Body Processing
  // --------------------------------------------------------------------------
  console.log('\n▶ [TEST 6] Testing Plain-Text and HTML Body Parsing...');
  try {
    const providerEmailId = `resend-rich-${Date.now()}`;
    const subject = `Rich Formatted Inbound Test ${Date.now()}`;
    const htmlContent = '<div style="color: blue;"><h1>Heading</h1><p>Paragraph with <a href="#">link</a></p></div>';

    const eventRecord = {
      id: 99904,
      event_id: `evt_rich_${Date.now()}`,
      event_type: 'email.received',
      payload: {
        type: 'email.received',
        data: {
          email_id: providerEmailId,
          from: '"Marketing Lead" <news@agency.com>',
          to: ['alice@inbound-test.com'],
          subject: subject,
          text: 'Heading\nParagraph with link',
          html: htmlContent
        }
      }
    };

    await processInboundEvent(eventRecord, null);
    const emails = getEmails(mailboxA.id, 'inbox');
    const target = emails.find(e => e.subject === subject);
    assert.ok(target, 'Email must be saved in database');
    assert.strictEqual(target.from_name, 'Marketing Lead');
    assert.strictEqual(target.body_html, htmlContent);

    report('Plain-Text & HTML Formatted Body Verified', true, 'Sender display name and HTML DOM structure preserved');
  } catch (err) {
    report('Plain-Text & HTML Formatted Body Verified', false, err.message);
  }

  // --------------------------------------------------------------------------
  // TEST 7: Inbound Binary Attachments
  // --------------------------------------------------------------------------
  console.log('\n▶ [TEST 7] Testing Inbound Binary Attachment Handling...');
  try {
    const providerEmailId = `resend-att-${Date.now()}`;
    const subject = `Email With PDF Attachment ${Date.now()}`;
    const testPdfData = Buffer.from('%PDF-1.4 Mock Binary PDF Content Here').toString('base64');

    const eventRecord = {
      id: 99905,
      event_id: `evt_att_${Date.now()}`,
      event_type: 'email.received',
      payload: {
        type: 'email.received',
        data: {
          email_id: providerEmailId,
          from: 'contracts@enterprise.com',
          to: ['alice@inbound-test.com'],
          subject: subject,
          text: 'Please review attached PDF.',
          attachments: [
            {
              filename: 'invoice_2026.pdf',
              content_type: 'application/pdf',
              size: Buffer.from(testPdfData, 'base64').byteLength,
              content: testPdfData
            }
          ]
        }
      }
    };

    await processInboundEvent(eventRecord, null);
    const emails = getEmails(mailboxA.id, 'inbox');
    const target = emails.find(e => e.subject === subject);
    assert.ok(target, 'Email must be stored');
    assert.strictEqual(target.attachment_count, 1, 'Email must have 1 attachment count');

    const dbAtt = db.prepare(`SELECT * FROM attachments WHERE email_id = ?`).get(target.id);
    assert.ok(dbAtt);
    assert.strictEqual(dbAtt.filename, 'invoice_2026.pdf');
    assert.strictEqual(dbAtt.content_type, 'application/pdf');
    assert.strictEqual(dbAtt.data_base64, testPdfData);

    report('Binary Attachments Preserved & Stored in SQLite', true, `Stored ${dbAtt.filename} (${dbAtt.size} bytes) with accurate MIME type`);
  } catch (err) {
    report('Binary Attachments Preserved & Stored in SQLite', false, err.message);
  }

  // --------------------------------------------------------------------------
  // TEST 8: Application Restart with Pending Queue Recovery
  // --------------------------------------------------------------------------
  console.log('\n▶ [TEST 8] Testing Application Restart & Queue Recovery...');
  try {
    const pendingEventId = `evt_recovery_${Date.now()}`;
    const providerId = `resend-recov-${Date.now()}`;

    // Insert pending event into queue table (simulating crash before processing)
    recordInboundEvent(pendingEventId, 'email.received', {
      type: 'email.received',
      data: {
        email_id: providerId,
        from: 'ceo@startup.io',
        to: ['bob@inbound-test.com'],
        subject: 'Queued During Offline Period',
        text: 'This email was pending in SQLite queue during restart'
      }
    });

    const pendingBefore = getPendingInboundEvents(10).filter(e => e.event_id === pendingEventId);
    assert.strictEqual(pendingBefore.length, 1, 'Event must be in pending status');

    // Simulate recovery worker running on startup
    const processedCount = await drainPendingInboundQueue(null);
    assert.ok(processedCount >= 1, 'Queue drainage must recover pending event');

    const updatedEvent = getInboundEventById(pendingEventId);
    assert.strictEqual(updatedEvent.status, 'completed', 'Event must transition to completed');

    report('Application Restart Queue Recovery Verified', true, 'Pending event recovered from SQLite and processed successfully');
  } catch (err) {
    report('Application Restart Queue Recovery Verified', false, err.message);
  }

  // --------------------------------------------------------------------------
  // TEST 9: Cross-Tenant Isolation
  // --------------------------------------------------------------------------
  console.log('\n▶ [TEST 9] Testing Cross-Tenant Mailbox Isolation...');
  try {
    // Alice's emails should never be in Bob's list
    const aliceEmails = getEmails(mailboxA.id, 'inbox');
    const bobEmails = getEmails(mailboxB.id, 'inbox');

    const aliceHasBobMail = aliceEmails.some(e => e.mailbox_id !== mailboxA.id);
    const bobHasAliceMail = bobEmails.some(e => e.mailbox_id !== mailboxB.id);

    assert.strictEqual(aliceHasBobMail, false);
    assert.strictEqual(bobHasAliceMail, false);

    report('Cross-Tenant Mailbox Isolation Enforced', true, `Alice's inbox (${aliceEmails.length}) and Bob's inbox (${bobEmails.length}) strictly partitioned`);
  } catch (err) {
    report('Cross-Tenant Mailbox Isolation Enforced', false, err.message);
  }

  console.log('\n================================================================');
  console.log(`📊 FINAL TEST REPORT: ${passed} PASSED / ${failed} FAILED`);
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTestSuite().catch(err => {
  console.error('Test Suite Fatal Error:', err);
  process.exit(1);
});
