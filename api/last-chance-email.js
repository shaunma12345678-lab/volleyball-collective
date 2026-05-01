const nodemailer = require('nodemailer');
const { checkAdminAuth } = require('./_adminAuth');

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

// Single transport reused for all emails in this invocation
function makeTransport() {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS },
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { dropId, adminPw } = req.body || {};
  const authErr = await checkAdminAuth(req, adminPw);
  if (authErr) return res.status(authErr.status).json(authErr.json);
  if (!dropId) return res.status(400).json({ error: 'Missing dropId' });

  if (!process.env.GMAIL_USER || !process.env.GMAIL_PASS)
    return res.status(503).json({ error: 'Email not configured' });

  const dropRaw = await redis('GET', `drop:${dropId}`);
  if (!dropRaw) return res.status(404).json({ error: 'Drop not found' });
  const drop = JSON.parse(dropRaw);

  const allIds = (await redis('SMEMBERS', 'bids:keys')) || [];
  const dropBids = (await Promise.all(
    allIds.map(async id => {
      try {
        const raw = await redis('GET', `bid:${id}`);
        const b = JSON.parse(raw);
        return b.dropId === dropId && b.email ? b : null;
      } catch { return null; }
    })
  )).filter(Boolean);

  if (!dropBids.length) return res.status(200).json({ sent: 0 });

  // Deduplicate by email, keep the highest bid per person
  const byEmail = {};
  for (const b of dropBids) {
    const key = b.email.toLowerCase().trim();
    if (!byEmail[key] || parseFloat(b.amount) > parseFloat(byEmail[key].amount)) byEmail[key] = b;
  }
  const uniqueBidders = Object.values(byEmail);
  const topBid = uniqueBidders.reduce((top, b) => parseFloat(b.amount) > parseFloat(top.amount) ? b : top, uniqueBidders[0]);

  const t = makeTransport();
  let sent = 0;

  for (const bid of uniqueBidders) {
    const isWinning = bid.email.toLowerCase().trim() === topBid.email.toLowerCase().trim();
    let unsubUrl = 'https://volleyball-collective.vercel.app/api/unsubscribe';
    try {
      const subRaw = await redis('GET', `emailsub:${bid.email.toLowerCase().trim()}`);
      if (subRaw) { const sub = JSON.parse(subRaw); if (sub.unsubToken) unsubUrl += `?t=${sub.unsubToken}`; }
    } catch {}

    const statusLine = isWinning
      ? `<div style="background:rgba(62,207,142,.1);border-left:3px solid #3ecf8e;padding:12px 16px;border-radius:3px;margin:16px 0;font-size:13px;color:#3ecf8e"><strong>You are currently winning</strong> with a bid of <strong>$${parseFloat(bid.amount).toFixed(2)}</strong>. But the auction isn't over yet — stay sharp.</div>`
      : `<div style="background:rgba(237,41,57,.08);border-left:3px solid #ED2939;padding:12px 16px;border-radius:3px;margin:16px 0;font-size:13px;color:#ED2939"><strong>You are currently not the highest bidder.</strong> This is your last chance to get back in and win.</div>`;

    try {
      await t.sendMail({
        from: `"Volleyball Collective" <${process.env.GMAIL_USER}>`,
        to: bid.email,
        subject: `⏰ Last chance — "${drop.name}" is closing soon`,
        html: `
          <div style="font-family:'DM Sans',Helvetica,Arial,sans-serif;max-width:500px;margin:0 auto;background:#00154F;color:#F5F0E8;padding:36px 32px;border-radius:6px">
            <div style="font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#ED2939;margin-bottom:8px">Volleyball Collective</div>
            <h2 style="font-size:26px;margin:0 0 16px;font-weight:700">This auction is closing.</h2>
            <p style="margin:0 0 12px">Hey <strong>${bid.name}</strong>,</p>
            <p style="margin:0 0 4px;line-height:1.6">The auction for <strong>${drop.name}</strong> is ending soon. This is your final chance to bid.</p>
            ${statusLine}
            <div style="background:rgba(255,255,255,.05);border-radius:4px;padding:14px 18px;margin-bottom:20px;font-size:13px;line-height:1.7">
              <strong style="color:#3ecf8e">Remember:</strong> You are only charged if you win.<br>
              If you lose, your card is never touched — you owe $0.
            </div>
            <a href="https://volleyball-collective.vercel.app/#drops" style="display:inline-block;background:#ED2939;color:#fff;padding:14px 32px;font-family:'DM Sans',sans-serif;font-size:.8rem;letter-spacing:3px;text-transform:uppercase;text-decoration:none;border-radius:2px">Bid Now →</a>
            <p style="margin:24px 0 0;font-size:11px;color:#7b9fd4">— Volleyball Collective</p>
            <p style="margin:10px 0 0;font-size:10px;color:#4a6fa0"><a href="${unsubUrl}" style="color:#4a6fa0">Unsubscribe</a> from drop alerts</p>
          </div>
        `,
      });
      sent++;
    } catch (e) {
      console.warn(`Last chance email failed for ${bid.email}:`, e.message);
    }
  }

  return res.status(200).json({ success: true, sent });
};
