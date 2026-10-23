import { sendEmail } from './src/smtp/sender.js';

async function main() {
  console.log('🚀 Sending official launch test email from ceo@wazemtech.com...');
  
  const result = await sendEmail({
    fromEmail: 'ceo@wazemtech.com',
    toEmail: 'waseemgaming40@gmail.com',
    subject: 'Official Launch: WazemTech Email Platform is LIVE! 🚀',
    bodyText: 'Assalam-o-Alaikum Waseem Bhai!\n\nThis is the official test email sent from ceo@wazemtech.com to waseemgaming40@gmail.com.\n\nYour custom email platform, DKIM 2048-bit encryption, and multi-domain architecture are working!',
    bodyHtml: `
      <div style="font-family: Arial, sans-serif; padding: 28px; background: #0f172a; color: #f8fafc; border-radius: 12px; max-width: 600px; border: 1px solid #334155;">
        <div style="display: flex; align-items: center; margin-bottom: 20px;">
          <h2 style="color: #38bdf8; margin: 0;">Assalam-o-Alaikum Waseem Bhai! 🚀</h2>
        </div>
        <p style="font-size: 16px; color: #e2e8f0; line-height: 1.6;">
          Mubarak ho! This email was successfully dispatched from your self-hosted email platform using <strong>ceo@wazemtech.com</strong>.
        </p>
        <div style="background: #1e293b; padding: 18px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #38bdf8;">
          <p style="margin: 0 0 8px 0; font-weight: bold; color: #38bdf8;">Verified Dispatch Details:</p>
          <ul style="margin: 0; padding-left: 20px; color: #cbd5e1; line-height: 1.8;">
            <li><strong>Sender:</strong> ceo@wazemtech.com</li>
            <li><strong>Recipient:</strong> waseemgaming40@gmail.com</li>
            <li><strong>Domain:</strong> wazemtech.com (Verified on DNS)</li>
            <li><strong>DKIM:</strong> 2048-bit Cryptographic Signature Attached</li>
            <li><strong>Delivery Engine:</strong> AetherMail Node.js SMTP Platform</li>
          </ul>
        </div>
        <p style="color: #94a3b8; font-size: 14px; margin-bottom: 0;">
          All systems are green! You can now send emails from any address under wazemtech.com (like info@, support@, etc.).
        </p>
      </div>
    `
  });

  console.log('Result:', JSON.stringify(result, null, 2));
}

main().catch(console.error);
