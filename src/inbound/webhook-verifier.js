import crypto from 'node:crypto';

/**
 * Verifies the Svix webhook signature sent by Resend
 * 
 * Resend signs incoming webhooks using Svix:
 * Headers:
 *   - svix-id: unique message identifier
 *   - svix-timestamp: unix timestamp of event
 *   - svix-signature: comma or space-separated list of signatures (e.g. "v1,abc... v1,xyz...")
 * 
 * @param {Object} params
 * @param {string|Buffer} params.rawBody - Raw unparsed HTTP request body
 * @param {Object} params.headers - Incoming HTTP request headers
 * @param {string} params.secret - Webhook signing secret (starts with "whsec_")
 * @param {number} [params.toleranceSeconds=300] - Maximum allowed timestamp drift (default 5 min)
 * @returns {{ valid: boolean, error?: string }}
 */
export function verifyResendWebhook({ rawBody, headers, secret, toleranceSeconds = 300 }) {
  if (!secret) {
    return { valid: false, error: 'Webhook secret is not configured' };
  }

  const svixId = headers['svix-id'] || headers['svix_id'];
  const svixTimestamp = headers['svix-timestamp'] || headers['svix_timestamp'];
  const svixSignature = headers['svix-signature'] || headers['svix_signature'];

  if (!svixId || !svixTimestamp || !svixSignature) {
    return { valid: false, error: 'Missing required svix headers (svix-id, svix-timestamp, svix-signature)' };
  }

  // 1. Check timestamp tolerance to prevent replay attacks
  const timestampNum = parseInt(svixTimestamp, 10);
  if (isNaN(timestampNum)) {
    return { valid: false, error: 'Invalid svix-timestamp header' };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - timestampNum) > toleranceSeconds) {
    return { valid: false, error: `Timestamp out of tolerance window (${Math.abs(nowSec - timestampNum)}s > ${toleranceSeconds}s)` };
  }

  // 2. Decode secret key (strip 'whsec_' prefix if present)
  let secretKey;
  try {
    const rawKey = secret.startsWith('whsec_') ? secret.slice(6) : secret;
    secretKey = Buffer.from(rawKey, 'base64');
  } catch (err) {
    return { valid: false, error: 'Failed to decode webhook signing secret: ' + err.message };
  }

  // 3. Compute signed content: "${svix_id}.${svix_timestamp}.${raw_body}"
  const bodyString = typeof rawBody === 'string' ? rawBody : (rawBody ? rawBody.toString('utf8') : '');
  const toSign = `${svixId}.${svixTimestamp}.${bodyString}`;

  const computedHmac = crypto.createHmac('sha256', secretKey).update(toSign).digest('base64');
  const expectedSig = `v1,${computedHmac}`;

  // 4. Constant-time comparison against signatures
  // Header can contain space-delimited signatures (e.g. "v1,g0hM9... v1,k9f2...")
  const passedSignatures = svixSignature.split(' ');
  const expectedBuffer = Buffer.from(expectedSig);

  for (const sig of passedSignatures) {
    const sigBuffer = Buffer.from(sig);
    if (sigBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
      return { valid: true };
    }
  }

  return { valid: false, error: 'Signature verification failed: no matching signature' };
}

/**
 * Helper to generate valid Svix webhook headers for testing
 */
export function generateSvixHeaders({ payload, secret, id = null, timestamp = null }) {
  const svixId = id || `msg_${crypto.randomBytes(12).toString('hex')}`;
  const svixTimestamp = String(timestamp || Math.floor(Date.now() / 1000));
  const rawKey = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  const secretKey = Buffer.from(rawKey, 'base64');

  const bodyString = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const toSign = `${svixId}.${svixTimestamp}.${bodyString}`;
  const hmac = crypto.createHmac('sha256', secretKey).update(toSign).digest('base64');

  return {
    'svix-id': svixId,
    'svix-timestamp': svixTimestamp,
    'svix-signature': `v1,${hmac}`
  };
}
