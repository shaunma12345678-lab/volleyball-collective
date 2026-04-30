const nodemailer = require('nodemailer');
const crypto = require('crypto');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

async function redis(...args) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Database not configured');
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
}

async function sendWelcomeEmail(email, code, unsubToken) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_PASS) return;
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS },
  });
  const unsubUrl = `https://volleyball-collective.vercel.app/api/unsubscribe?t=${unsubToken}`;
  await transporter.sendMail({
    from: `"Volleyball Collective" <${process.env.GMAIL_USER}>`,
    to: email,
    subject: `You're on the list — here's your 10% off code`,
    html: `
      <div style="font-family:'DM Sans',Helvetica,Arial,sans-serif;max-width:500px;margin:0 auto;background:#00154F;color:#F5F0E8;padding:36px 32px;border-radius:6px">
        <div style="font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#ED2939;margin-bottom:8px">Volleyball Collective</div>
        <h2 style="font-size:24px;margin:0 0 16px;font-weight:700">You're In. 🏐</h2>
        <p style="margin:0 0 20px;line-height:1.6;color:#7b9fd4">You'll now get an email every time we drop new jerseys. As a thank you, here's 10% off your first purchase:</p>
        <div style="background:rgba(62,207,142,.08);border:1px solid rgba(62,207,142,.25);border-radius:4px;padding:20px;text-align:center;margin:0 0 20px">
          <div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#7b9fd4;margin-bottom:8px">Your Discount Code</div>
          <div style="font-family:monospace;font-size:28px;font-weight:700;letter-spacing:4px;color:#3ecf8e">${code}</div>
          <div style="font-size:11px;color:#7b9fd4;margin-top:8px">10% off · One-time use · Any purchase</div>
        </div>
        <p style="margin:0 0 20px;font-size:13px;line-height:1.6;color:#7b9fd4">Enter this code at checkout on any bid or buy now item. Valid for one use only — don't share it!</p>
        <a href="https://volleyball-collective.vercel.app" style="display:inline-block;background:#ED2939;color:#fff;padding:14px 32px;font-family:'DM Sans',sans-serif;font-size:.8rem;letter-spacing:3px;text-transform:uppercase;text-decoration:none;border-radius:2px">Shop The Drops →</a>
        <p style="margin:24px 0 0;font-size:11px;color:#7b9fd4">— Volleyball Collective</p>
        <p style="margin:16px 0 0;font-size:10px;color:#4a6fa0">You're receiving this because you signed up for drop alerts. <a href="${unsubUrl}" style="color:#4a6fa0">Unsubscribe</a></p>
      </div>
    `,
  });
}

module.exports = async (req, res) => {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET — admin only, returns all email subscribers
  if (req.method === 'GET') {
    if ((req.query || {}).adminPw !== ADMIN_PASSWORD) return res.status(403).json({ error: 'Unauthorized' });
    try {
      const emails = (await redis('SMEMBERS', 'emailsubs:all')) || [];
      const subscribers = (await Promise.all(
        emails.map(async (email) => {
          const raw = await redis('GET', `emailsub:${email}`);
          try { return JSON.parse(raw); } catch { return null; }
        })
      )).filter(Boolean).sort((a, b) => new Date(b.subscribedAt) - new Date(a.subscribedAt));
      return res.status(200).json({ subscribers });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // POST — subscribe
  if (req.method === 'POST') {
    const { email } = req.body || {};
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: 'Please enter a valid email address' });

    const cleanEmail = email.toLowerCase().trim();

    try {
      const existing = await redis('GET', `emailsub:${cleanEmail}`);
      if (existing) return res.status(409).json({ error: 'This email is already subscribed' });

      // Generate unique welcome discount code and unsubscribe token
      const code = 'WELCOME' + crypto.randomBytes(3).toString('hex').toUpperCase();
      const unsubToken = crypto.randomBytes(16).toString('hex');

      // Store subscriber
      await redis('SET', `emailsub:${cleanEmail}`, JSON.stringify({
        email: cleanEmail,
        subscribedAt: new Date().toISOString(),
        welcomeCode: code,
        unsubToken,
      }));
      await redis('SADD', 'emailsubs:all', cleanEmail);
      await redis('SET', `unsub:${unsubToken}`, cleanEmail);

      // Store as a promo code (maxUses: 1, one-time welcome discount)
      await redis('SET', `promo:${code}`, JSON.stringify({
        code,
        label: `Welcome — ${cleanEmail}`,
        discount: 10,
        active: true,
        maxUses: 1,
        buyNowUses: 0,
        bidUses: 0,
        buyNowRevenue: 0,
        bidRevenue: 0,
        type: 'welcome',
        createdAt: new Date().toISOString(),
      }));
      await redis('SADD', 'promos:all', code);

      try { await sendWelcomeEmail(cleanEmail, code, unsubToken); } catch (e) { console.warn('Welcome email failed:', e.message); }

      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('email-subscribe error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
