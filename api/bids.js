const nodemailer = require('nodemailer');

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

async function sendConfirmationEmail(bid, dropName) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_PASS) return;
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS },
  });
  await transporter.sendMail({
    from: `"Volleyball Collective" <${process.env.GMAIL_USER}>`,
    to: bid.email,
    subject: `Your bid on "${dropName}" is secured!`,
    html: `
      <div style="font-family:'DM Sans',Helvetica,Arial,sans-serif;max-width:500px;margin:0 auto;background:#00154F;color:#F5F0E8;padding:36px 32px;border-radius:6px">
        <div style="font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#ED2939;margin-bottom:8px">Volleyball Collective</div>
        <h2 style="font-size:24px;margin:0 0 20px;font-weight:700">Your bid is locked in</h2>
        <p style="margin:0 0 12px">Hey <strong>${bid.name}</strong>,</p>
        <p style="margin:0 0 20px;line-height:1.6">Your bid of <strong style="color:#ED2939;font-size:18px">$${parseFloat(bid.amount).toFixed(2)}</strong> on <strong>${dropName}</strong> has been recorded and your card is saved securely via Stripe.</p>
        <div style="background:rgba(255,255,255,0.06);border-left:3px solid #ED2939;padding:14px 18px;border-radius:3px;margin-bottom:20px">
          <p style="margin:0;font-size:13px;line-height:1.6"><strong>Your card is NOT charged yet.</strong><br>Only the winning bidder is charged — everyone else owes nothing.</p>
        </div>
        <table style="font-size:13px;width:100%;border-collapse:collapse">
          <tr><td style="padding:6px 0;color:#7b9fd4">Item</td><td style="padding:6px 0;text-align:right">${dropName}</td></tr>
          <tr><td style="padding:6px 0;color:#7b9fd4">Your Bid</td><td style="padding:6px 0;text-align:right;color:#ED2939;font-weight:700">$${parseFloat(bid.amount).toFixed(2)}</td></tr>
          ${bid.address ? `<tr><td style="padding:6px 0;color:#7b9fd4">Ship To</td><td style="padding:6px 0;text-align:right">${bid.address.city}, ${bid.address.state}</td></tr>` : ''}
        </table>
        <p style="margin:24px 0 0;font-size:11px;color:#7b9fd4">Good luck! — Volleyball Collective</p>
      </div>
    `,
  });
}

module.exports = async (req, res) => {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ADMIN_PW = process.env.ADMIN_PASSWORD || 'vb2024';

  try {
    if (req.method === 'GET') {
      const isAdmin = (req.query || {}).adminPw === ADMIN_PW;
      const ids = (await redis('SMEMBERS', 'bids:keys')) || [];
      const bids = (
        await Promise.all(
          ids.map(async (id) => {
            const raw = await redis('GET', `bid:${id}`);
            try { return JSON.parse(raw); } catch { return null; }
          })
        )
      )
        .filter(Boolean)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

      if (isAdmin) return res.status(200).json({ bids });
      return res.status(200).json({
        bids: bids.map(b => ({ id: b.id, dropId: b.dropId, createdAt: b.createdAt })),
      });
    }

    const body = req.body || {};

    if (req.method === 'POST') {
      const bid = body.bid;
      if (!bid || !bid.id || !bid.dropId || !bid.name || !bid.email || !bid.amount)
        return res.status(400).json({ error: 'Missing required bid fields' });
      const existing = await redis('GET', `bid:${bid.id}`);
      if (existing)
        return res.status(409).json({ error: 'Bid with this id already exists' });
      await redis('SET', `bid:${bid.id}`, JSON.stringify(bid));
      await redis('SADD', 'bids:keys', bid.id);

      try {
        const dropRaw = await redis('GET', `drop:${bid.dropId}`);
        const dropName = dropRaw ? JSON.parse(dropRaw).name : 'this drop';
        await sendConfirmationEmail(bid, dropName);
      } catch (emailErr) {
        console.warn('Email send failed (non-fatal):', emailErr.message);
      }

      return res.status(200).json({ success: true });
    }

    if (req.method === 'PUT') {
      if (body.adminPw !== ADMIN_PW)
        return res.status(403).json({ error: 'Unauthorized' });
      const raw = await redis('GET', `bid:${body.id}`);
      if (!raw) return res.status(404).json({ error: 'Bid not found' });
      const bid = JSON.parse(raw);
      bid.charged = true;
      await redis('SET', `bid:${body.id}`, JSON.stringify(bid));
      return res.status(200).json({ success: true });
    }

    if (req.method === 'DELETE') {
      if (body.adminPw !== ADMIN_PW)
        return res.status(403).json({ error: 'Unauthorized' });
      const ids = (await redis('SMEMBERS', 'bids:keys')) || [];
      await Promise.all(
        ids.map(async (id) => {
          const raw = await redis('GET', `bid:${id}`);
          try {
            const bid = JSON.parse(raw);
            if (bid.dropId === body.dropId) {
              await redis('DEL', `bid:${id}`);
              await redis('SREM', 'bids:keys', id);
            }
          } catch {}
        })
      );
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('bids error:', err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
};
