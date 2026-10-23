# 🚀 Vercel Deployment Guide — AetherMail

Your project is now **100% prepared and ready** for Vercel deployment!

---

## 📁 Files Prepared for Vercel

1. **`api/index.js`**: Serverless function entrypoint connecting to Aiven PostgreSQL on cold start.
2. **`vercel.json`**: Directs all `/api/*` traffic to `api/index.js` and serves `public/` static frontend assets at the root.
3. **`src/server.js`**: Dual-mode engine that disables long-lived TCP sockets/ports inside Vercel serverless environments and queries Aiven PostgreSQL.
4. **`public/app.js`**: Includes background auto-polling fallback (every 8s) to guarantee instantaneous email delivery on serverless platforms.

---

## 🛠️ Step 1: Deploy to Vercel

You can deploy using either **Option A (GitHub)** or **Option B (Vercel CLI)**:

### Option A: Via GitHub (Recommended)
1. Push this folder to your GitHub repository:
   ```bash
   git init
   git add .
   git commit -m "feat: complete email server with Aiven PostgreSQL and Resend Inbound"
   git branch -M main
   git remote add origin https://github.com/<your-username>/<your-repo-name>.git
   git push -u origin main
   ```
2. Go to [vercel.com](https://vercel.com) and click **"Add New Project"**.
3. Import your GitHub repository.

### Option B: Via Vercel CLI (Direct from Terminal)
Run in this directory:
```bash
npx vercel
```
Follow the simple prompts in your terminal.

---

## 🔑 Step 2: Set Environment Variables in Vercel

In your Vercel Project Dashboard (**Settings -> Environment Variables**), add these 4 variables:

| Variable Name | Value | Description |
| :--- | :--- | :--- |
| `DATABASE_URL` | `postgres://avnadmin:<PASSWORD>@pg-2fc937ad-mail-server.b.aivencloud.com:12447/defaultdb?sslmode=require` | Your live Aiven Cloud PostgreSQL |
| `RESEND_API_KEY` | `re_YOUR_RESEND_API_KEY` | Resend API Key for sending and receiving details |
| `RESEND_WEBHOOK_SECRET` | `whsec_YOUR_WEBHOOK_SECRET` | Svix HMAC Signature Verification Secret |
| `PUBLIC_BASE_URL` | `https://mail.wazemtech.com` | Your public domain |

---

## 🌐 Step 3: Connect Subdomain (`mail.wazemtech.com`)

1. In Vercel Project Dashboard:
   - Go to **Settings -> Domains**.
   - Type **`mail.wazemtech.com`** and click **Add**.
2. In your DNS Provider (Cloudflare, Namecheap, etc.):
   - Add a **CNAME** Record:
     - **Type:** `CNAME`
     - **Name / Host:** `mail`
     - **Target / Value:** `cname.vercel-dns.com`

---

## 📥 Step 4: Resend Inbound Webhook is Live!

Once your Vercel deployment is active and `mail.wazemtech.com` has an active SSL certificate:
- Webhook URL: `https://mail.wazemtech.com/api/webhooks/resend/inbound`
- Any email sent to `ceo@wazemtech.com`, `admin@wazemtech.com`, or any other mailbox on your domain will automatically arrive in your live Webmail interface within seconds!
