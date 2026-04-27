const nodemailer = require('nodemailer');
const crypto = require('crypto');

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

async function sendDropDiscountEmail(email, code, dropName, unsubUrl) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_PASS) return;
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS },
  });
  await transporter.sendMail({
    from: `"Volleyball Collective" <${process.env.GMAIL_USER}>`,
    to: email,
    subject: `Your 5% off code for "${dropName}"`,
    html: `
      <div style="font-family:'DM Sans',Helvetica,Arial,sans-serif;max-width:500px;margin:0 auto;background:#00154F;color:#F5F0E8;padding:36px 32px;border-radius:6px">
        <div style="font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#ED2939;margin-bottom:8px">Volleyball Collective</div>
        <h2 style="font-size:24px;margin:0 0 16px;font-weight:700">Here's your 5% off. 🏐</h2>
        <p style="margin:0 0 20px;line-height:1.6;color:#7b9fd4">You showed interest in <strong style="color:#F5F0E8">${dropName}</strong>. Use this code at checkout — it's valid on any bid or purchase, one time only.</p>
        <div style="background:rgba(62,207,142,.08);border:1px solid rgba(62,207,142,.25);border-radius:4px;padding:20px;text-align:center;margin:0 0 24px">
          <div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#7b9fd4;margin-bottom:8px">Your Discount Code</div>
          <div style="font-family:monospace;font-size:28px;font-weight:700;letter-spacing:4px;color:#3ecf8e">${code}</div>
          <div style="font-size:11px;color:#7b9fd4;margin-top:8px">5% off · One-time use · Any purchase</div>
        </div>
        <a href="https://volleyball-collective.vercel.app" style="display:inline-block;background:#ED2939;color:#fff;padding:14px 32px;font-family:'DM Sans',sans-serif;font-size:.8rem;letter-spacing:3px;text-transform:uppercase;text-decoration:none;border-radius:2px">Go Grab It →</a>
        <p style="margin:24px 0 0;font-size:11px;color:#7b9fd4">— Volleyball Collective</p>
        <p style="margin:12px 0 0;font-size:10px;color:#4a6fa0">You're on our drop alert list. <a href="${unsubUrl}" style="color:#4a6fa0">Unsubscribe</a></p>
      </div>
    `,
  });
}

module.exports = async (req, res) => {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { dropId, email, dropName } = req.body || {};
  if (!dropId) return res.status(400).json({ error: 'dropId is required' });
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: 'Please enter a valid email address' });

  const cleanEmail = email.toLowerCase().trim();

  try {
    // One code per email per drop — return the existing one if already claimed
    const existingCode = await redis('GET', `drop-signup:${dropId}:${cleanEmail}`);
    if (existingCode) {
      return res.status(200).json({ success: true, code: existingCode, existing: true });
    }

    const code = 'DROP5' + crypto.randomBytes(3).toString('hex').toUpperCase();

    // Store the promo code
    await redis('SET', `promo:${code}`, JSON.stringify({
      code,
      label: `Drop Interest — ${cleanEmail}`,
      discount: 5,
      active: true,
      maxUses: 1,
      buyNowUses: 0,
      bidUses: 0,
      buyNowRevenue: 0,
      bidRevenue: 0,
      type: 'drop-signup',
      dropId,
      createdAt: new Date().toISOString(),
    }));
    await redis('SADD', 'promos:all', code);
    // Track per drop+email so same person can't claim twice
    await redis('SET', `drop-signup:${dropId}:${cleanEmail}`, code);

    // Auto-subscribe to drop alerts
    let unsubUrl = 'https://volleyball-collective.vercel.app/api/unsubscribe';
    const existingSub = await redis('GET', `emailsub:${cleanEmail}`);
    if (!existingSub) {
      const unsubToken = crypto.randomBytes(16).toString('hex');
      await redis('SET', `emailsub:${cleanEmail}`, JSON.stringify({
        email: cleanEmail,
        subscribedAt: new Date().toISOString(),
        autoSubscribed: true,
        unsubToken,
      }));
      await redis('SADD', 'emailsubs:all', cleanEmail);
      await redis('SET', `unsub:${unsubToken}`, cleanEmail);
      unsubUrl += `?t=${unsubToken}`;
    } else {
      try {
        const sub = JSON.parse(existingSub);
        if (sub.unsubToken) unsubUrl += `?t=${sub.unsubToken}`;
      } catch {}
    }

    sendDropDiscountEmail(cleanEmail, code, dropName || 'this drop', unsubUrl).catch(() => {});

    return res.status(200).json({ success: true, code });
  } catch (err) {
    console.error('drop-signup error:', err);
    return res.status(500).json({ error: err.message });
  }
};
