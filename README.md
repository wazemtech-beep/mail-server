# 🚀 AetherMail — Two-Way Self-Hosted Email Platform

A modern, high-performance, self-hosted email server engine and webmail platform with **RFC 5321 SMTP**, **MIME Mailparser**, **SQLite Persistence**, **DKIM 2048-bit Cryptographic Signing**, and **Two-Way External Email Inbound & Outbound Delivery via Resend Infrastructure**.

---

## 🏗️ Inbound Architecture & Message Flow

```
[ External Sender: Gmail / Outlook / Yahoo ]
                    │
                    ▼
┌─────────────────────────────────────────────────────────────┐
│ 1. DNS Inbound MX Routing                                   │
│    - Domain MX points to Resend receiving infrastructure    │
│      (e.g., Priority 10 -> receive.forge.rmta.net)          │
└───────────────────────────┬─────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. Resend Inbound Parser & Webhook Dispatch                 │
│    - Parses incoming MIME, signs with Svix HMAC-SHA256      │
│    - Dispatches HTTP POST to:                               │
│      https://<YOUR-PUBLIC-URL>/api/webhooks/resend/inbound  │
└───────────────────────────┬─────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. AetherMail Webhook Controller & Verification             │
│    - Verifies Svix signature (svix-id, svix-timestamp)      │
│    - Idempotency check (prevents duplicate webhook replays) │
│    - Persists raw event into SQLite inbound_events queue    │
└───────────────────────────┬─────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. Retrieval & Attachment Processing                        │
│    - Queries Resend Inbound API (GET /emails/receiving/:id) │
│    - Queries Attachments API (downloads binary & base64)    │
│    - Replay protection & exponential backoff queue worker   │
└───────────────────────────┬─────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ 5. Virtual Mailbox Routing & Atomic Storage                 │
│    - Matches recipient against virtual mailboxes table      │
│    - Commits email & attachments in atomic SQL transaction  │
│    - Enforces cross-tenant isolation                        │
└───────────────────────────┬─────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ 6. Real-Time Scoped Inbox Notification                      │
│    - Server-Sent Events (SSE) scoped strictly to mailbox ID │
│    - Live Webmail UI updates unread count & renders email   │
└─────────────────────────────────────────────────────────────┘
```

---

## 🔑 Required Environment Variables

Configure these in your environment or a `.env` file:

| Variable | Description | Example / Current |
| :--- | :--- | :--- |
| `RESEND_API_KEY` | Resend API Key for sending and receiving APIs | `re_YOUR_RESEND_API_KEY` |
| `RESEND_WEBHOOK_SECRET` | Svix Webhook Signing Secret from Resend dashboard | `whsec_...` |
| `PUBLIC_BASE_URL` | Public HTTPS URL (Cloudflare Tunnel / ngrok / domain) | `https://mail.yourdomain.com` |
| `PORT` | Local Web & API port | `3000` (default) |
| `SMTP_PORT` | Local SMTP socket port | `2525` (default) |
| `HOST` | Loopback binding address | `127.0.0.1` (default) |

---

## 📋 Resend & DNS Configuration Guide

### Step 1: Enable Inbound Receiving in Resend
1. Log into your **Resend Dashboard** ([resend.com](https://resend.com)).
2. Navigate to **Domains** and select your verified domain (e.g. `wazemtech.com`).
3. Click the **Receiving** tab or toggle **Enable Inbound Receiving**.
4. Resend will display the designated **MX Record** (typically `receive.forge.rmta.net`, Priority `10`).

> 💡 **Best Practice Note on Root vs Subdomain:**
> - If you don't have an existing mail provider on your root domain, add the MX record on `@` (`wazemtech.com`).
> - If your root domain already has an active mail service (Google Workspace / M365), create an **inbound subdomain** (e.g., `inbound.wazemtech.com`) to isolate inbound routing.

### Step 2: Add Inbound MX Record to DNS
In your DNS management panel (Cloudflare / Namecheap / cPanel):
* **Type:** `MX`
* **Name / Host:** `@` (or `inbound` if using subdomain)
* **Priority:** `10`
* **Value / Target:** `receive.forge.rmta.net`

### Step 3: Configure Resend Inbound Webhook
1. In the Resend Dashboard, go to **Webhooks** (Left Sidebar).
2. Click **Add Webhook**:
   - **Endpoint URL:** `https://<YOUR-PUBLIC-URL>/api/webhooks/resend/inbound`
   - **Events:** Check **`email.received`**
3. Save the webhook.
4. Copy the **Signing Secret** (starts with `whsec_...`).
5. Set it as your environment variable:
   ```powershell
   $env:RESEND_WEBHOOK_SECRET = "whsec_your_secret_here"
   ```

### Step 4: Exposing Your Local Server for Development (Free Tunnel)
Because your home internet is behind CGNAT / dynamic IP, you need a public HTTPS URL to receive webhooks. You can use free Cloudflare Tunnel or ngrok:

**Option A — Cloudflare Tunnel (100% Free):**
```powershell
cloudflared tunnel --url http://localhost:3000
```

**Option B — Ngrok (100% Free):**
```powershell
ngrok http 3000
```
Copy the generated `https://xxxx.trycloudflare.com` or `https://xxxx.ngrok-free.app` URL and paste it into Resend's Webhook URL configuration:
`https://xxxx.trycloudflare.com/api/webhooks/resend/inbound`

---

## 🧪 Automated Verification Suite

Run all test suites to verify inbound receiving, signature verification, and atomic persistence:

```powershell
# 1. Run Complete Inbound Logic & Routing Test Suite
npm run test:inbound

# 2. Run Live HTTP Webhook Integration Test (Svix Verification & Idempotency)
npm run test:webhook

# 3. Run SMTP Receiver & Scrypt Auth Verification
npm run test:smtp
```

### Verified Test Cases:
- [x] **Valid Svix Webhook Signature:** Validated with HMAC-SHA256 and timestamp drift protection.
- [x] **Tampered / Invalid Signature:** Rejected with `HTTP 401 Unauthorized`.
- [x] **Idempotent Delivery:** Duplicate webhook submissions recognized and deduplicated; zero duplicate emails.
- [x] **Unknown Recipient Protection:** Messages to non-existent addresses rejected and safely logged; no ghost mailboxes.
- [x] **Multi-Recipient Delivery:** Broadcasts accurately to all matching local mailboxes.
- [x] **Rich MIME Body Parsing:** Plain-text and HTML preserved with sender display name.
- [x] **Binary Attachments:** PDF/images/docs decoded, stored, and downloadable with mailbox authentication.
- [x] **Application Restart & Queue Recovery:** Pending/interrupted events recovered from SQLite queue on reboot.
- [x] **Cross-Tenant Isolation:** Mailbox data strictly isolated; SSE updates scoped to active mailbox.

---

## 🚀 Running the Server

```powershell
npm start
```
- **Webmail UI & Dashboard:** [http://localhost:3000](http://localhost:3000)
- **Local SMTP Receiver:** `127.0.0.1:2525`
- **Inbound Webhook Endpoint:** `POST /api/webhooks/resend/inbound`
