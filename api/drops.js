const nodemailer = require('nodemailer');

async function sendDropNotifications(drop) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_PASS) return;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return;

  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(['SMEMBERS', 'emailsubs:all']),
  });
  const { result: emails } = await r.json();
  if (!emails || !emails.length) return;

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS },
  });

  const isMembers = drop.memberOnly ? ' · Members Only' : '';
  const typeLabel = drop.type === 'buynow' ? `Buy Now — $${parseFloat(drop.price || 0).toFixed(2)}` : 'Auction Drop';

  for (const email of emails) {
    // Fetch unsub token per subscriber so each email has a unique one-click unsubscribe link
    let unsubUrl = 'https://volleyball-collective.vercel.app/api/unsubscribe';
    try {
      const subRaw = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(['GET', `emailsub:${email}`]),
      });
      const subData = await subRaw.json();
      if (subData.result) {
        const sub = JSON.parse(subData.result);
        if (sub.unsubToken) unsubUrl += `?t=${sub.unsubToken}`;
      }
    } catch {}

    transporter.sendMail({
      from: `"Volleyball Collective" <${process.env.GMAIL_USER}>`,
      to: email,
      subject: `New Drop Just Went Live — ${drop.name}`,
      html: `
        <div style="font-family:'DM Sans',Helvetica,Arial,sans-serif;max-width:500px;margin:0 auto;background:#00154F;color:#F5F0E8;padding:36px 32px;border-radius:6px">
          <div style="font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#ED2939;margin-bottom:8px">Volleyball Collective · New Drop</div>
          <h2 style="font-size:24px;margin:0 0 16px;font-weight:700">${drop.name} is Live 🏐</h2>
          ${drop.photo ? `<img src="${drop.photo}" alt="${drop.name}" style="width:100%;max-height:280px;object-fit:cover;border-radius:4px;margin-bottom:20px">` : ''}
          <div style="display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap">
            <span style="background:rgba(237,41,57,.12);border:1px solid rgba(237,41,57,.3);color:#ED2939;padding:4px 12px;font-size:.72rem;letter-spacing:2px;text-transform:uppercase;border-radius:2px">${typeLabel}</span>
            ${drop.memberOnly ? '<span style="background:rgba(123,159,212,.1);border:1px solid rgba(123,159,212,.3);color:#7b9fd4;padding:4px 12px;font-size:.72rem;letter-spacing:2px;text-transform:uppercase;border-radius:2px">🔒 Members Only</span>' : ''}
            ${drop.size ? `<span style="background:rgba(0,35,149,.2);border:1px solid rgba(0,35,149,.4);color:#7b9fd4;padding:4px 12px;font-size:.72rem;letter-spacing:2px;text-transform:uppercase;border-radius:2px">Size ${drop.size}</span>` : ''}
          </div>
          ${drop.desc ? `<p style="margin:0 0 24px;line-height:1.6;color:#7b9fd4">${drop.desc}</p>` : ''}
          <a href="https://volleyball-collective.vercel.app" style="display:inline-block;background:#ED2939;color:#fff;padding:14px 32px;font-family:'DM Sans',sans-serif;font-size:.8rem;letter-spacing:3px;text-transform:uppercase;text-decoration:none;border-radius:2px">${drop.type === 'buynow' ? 'Buy Now →' : 'Place Your Bid →'}</a>
          <p style="margin:24px 0 0;font-size:11px;color:#7b9fd4">You're receiving this because you signed up for drop alerts. — Volleyball Collective</p>
          <p style="margin:12px 0 0;font-size:10px;color:#4a6fa0"><a href="${unsubUrl}" style="color:#4a6fa0">Unsubscribe</a> from drop alerts</p>
        </div>
      `,
    }).catch(e => console.warn(`Notification failed for ${email}:`, e.message));
  }
}

async function redis(...args) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Database not configured — add UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in Vercel environment variables');
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
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
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
}

module.exports = async (req, res) => {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ADMIN_PW = process.env.ADMIN_PASSWORD || 'vb2024';

  try {
    if (req.method === 'GET') {
      const ids = (await redis('SMEMBERS', 'drops:keys')) || [];
      const drops = (
        await Promise.all(
          ids.map(async (id) => {
            const raw = await redis('GET', `drop:${id}`);
            try { return JSON.parse(raw); } catch { return null; }
          })
        )
      )
        .filter(Boolean)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      return res.status(200).json({ drops });
    }

    const body = req.body || {};

    if (req.method === 'POST') {
      if (body.adminPw !== ADMIN_PW)
        return res.status(403).json({ error: 'Unauthorized' });
      if (!body.drop || !body.drop.id || !body.drop.name)
        return res.status(400).json({ error: 'drop.id and drop.name are required' });
      const existing = await redis('GET', `drop:${body.drop.id}`);
      if (existing)
        return res.status(409).json({ error: 'Drop with this id already exists' });
      await redis('SET', `drop:${body.drop.id}`, JSON.stringify(body.drop));
      await redis('SADD', 'drops:keys', body.drop.id);
      if (body.drop.status === 'published') sendDropNotifications(body.drop).catch(() => {});
      return res.status(200).json({ success: true });
    }

    if (req.method === 'PUT') {
      if (body.adminPw !== ADMIN_PW)
        return res.status(403).json({ error: 'Unauthorized' });
      const raw = await redis('GET', `drop:${body.id}`);
      if (!raw)
        return res.status(404).json({ error: 'Drop not found' });
      const drop = JSON.parse(raw);
      drop.status = drop.status === 'published' ? 'archived' : 'published';
      await redis('SET', `drop:${body.id}`, JSON.stringify(drop));
      return res.status(200).json({ success: true });
    }

    if (req.method === 'DELETE') {
      if (body.adminPw !== ADMIN_PW)
        return res.status(403).json({ error: 'Unauthorized' });
      await redis('DEL', `drop:${body.id}`);
      await redis('SREM', 'drops:keys', body.id);
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('drops error:', err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
};
