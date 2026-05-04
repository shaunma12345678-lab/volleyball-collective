const nodemailer = require('nodemailer');

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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'DELETE') {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const { bidId } = body;
      if (!bidId) return res.status(400).json({ error: 'bidId required' });
      const raw = await redis('GET', `bid:${bidId}`);
      if (!raw) return res.status(404).json({ error: 'Bid not found' });
      const bid = JSON.parse(raw);
      delete bid.autoBid;
      await redis('SET', `bid:${bidId}`, JSON.stringify(bid));
      return res.status(200).json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { prevBidId } = req.body || {};
  if (!prevBidId) return res.status(400).json({ error: 'prevBidId required' });

  try {
    // Load the previous bid to inherit payment info and auto-bid config
    const prevRaw = await redis('GET', `bid:${prevBidId}`);
    if (!prevRaw) return res.status(404).json({ error: 'Previous bid not found' });
    const prevBid = JSON.parse(prevRaw);

    if (!prevBid.autoBid || !prevBid.autoBid.step) {
      return res.status(400).json({ error: 'Auto-bid not enabled on this bid' });
    }

    // Load the drop — must still be published
    const dropRaw = await redis('GET', `drop:${prevBid.dropId}`);
    if (!dropRaw) return res.status(404).json({ error: 'Drop not found' });
    const drop = JSON.parse(dropRaw);
    if (drop.status !== 'published') {
      return res.status(409).json({ error: 'Drop is no longer active' });
    }

    // Find current top bid for this drop
    const allBidIds = (await redis('SMEMBERS', 'bids:keys')) || [];
    const dropBids = (await Promise.all(
      allBidIds.map(async id => {
        try { const raw = await redis('GET', `bid:${id}`); return JSON.parse(raw); } catch { return null; }
      })
    )).filter(b => b && b.dropId === prevBid.dropId);

    const topBid = dropBids.reduce((mx, b) => Math.max(mx, parseFloat(b.amount || 0)), 0);
    const myHighestExisting = dropBids
      .filter(b => b.email.toLowerCase().trim() === prevBid.email.toLowerCase().trim())
      .reduce((mx, b) => Math.max(mx, parseFloat(b.amount || 0)), 0);

    // Only auto-bid if we're genuinely outbid
    if (myHighestExisting >= topBid) {
      return res.status(200).json({ skipped: true, reason: 'Already leading' });
    }

    const step = parseFloat(prevBid.autoBid.step) || 5;
    const maxBid = prevBid.autoBid.maxBid ? parseFloat(prevBid.autoBid.maxBid) : null;
    const newAmount = (topBid + step).toFixed(2);

    if (maxBid && parseFloat(newAmount) > maxBid) {
      return res.status(200).json({ skipped: true, reason: 'Max bid limit reached' });
    }

    // Create the new auto-bid, inheriting everything from the previous bid
    const newBid = {
      id: 'bid_' + Date.now(),
      dropId: prevBid.dropId,
      name: prevBid.name,
      email: prevBid.email,
      phone: prevBid.phone || '',
      msg: 'Auto-bid',
      amount: newAmount,
      paymentMethodId: prevBid.paymentMethodId,
      address: prevBid.address,
      createdAt: new Date().toISOString(),
      promoCode: prevBid.promoCode || null,
      promoDiscount: prevBid.promoDiscount || 0,
      shippingFee: prevBid.shippingFee || 0,
      isAutoBid: true,
      autoBid: prevBid.autoBid,
    };

    await redis('SET', `bid:${newBid.id}`, JSON.stringify(newBid));
    await redis('SADD', 'bids:keys', newBid.id);

    // Anti-sniping extension
    try {
      if (drop.endTime) {
        const msLeft = new Date(drop.endTime) - Date.now();
        if (msLeft > 0 && msLeft < 5 * 60 * 1000) {
          drop.endTime = new Date(Date.now() + 5 * 60 * 1000).toISOString();
          await redis('SET', `drop:${drop.id}`, JSON.stringify(drop));
        }
      }
    } catch {}

    // Outbid emails to everyone now below the new auto-bid
    try {
      const byEmail = {};
      for (const b of dropBids) {
        const key = b.email.toLowerCase().trim();
        if (key === newBid.email.toLowerCase().trim()) continue;
        if (!byEmail[key] || parseFloat(b.amount) > parseFloat(byEmail[key].amount)) byEmail[key] = b;
      }
      const outbidBids = Object.values(byEmail).filter(b => parseFloat(b.amount) < parseFloat(newAmount));
      if (outbidBids.length && process.env.GMAIL_USER && process.env.GMAIL_PASS) {
        const t = nodemailer.createTransport({
          service: 'gmail',
          auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS },
        });
        const rebidUrl = `https://volleyball-collective.vercel.app?bid=${prevBid.dropId}`;
        for (const ob of outbidBids) {
          t.sendMail({
            from: `"Volleyball Collective" <${process.env.GMAIL_USER}>`,
            to: ob.email,
            subject: `You've been outbid on "${drop.name}"`,
            html: `
              <div style="font-family:'DM Sans',Helvetica,Arial,sans-serif;max-width:500px;margin:0 auto;background:#00154F;color:#F5F0E8;padding:36px 32px;border-radius:6px">
                <div style="font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#ED2939;margin-bottom:8px">Volleyball Collective</div>
                <h2 style="font-size:26px;margin:0 0 16px;font-weight:700">You've been outbid.</h2>
                <p style="margin:0 0 20px;line-height:1.6">Hey <strong>${ob.name}</strong>, someone topped your $${parseFloat(ob.amount).toFixed(2)} bid on <strong>${drop.name}</strong>. New top: <strong style="color:#ED2939">$${parseFloat(newAmount).toFixed(2)}</strong>.</p>
                <a href="${rebidUrl}" style="display:inline-block;background:#ED2939;color:#fff;padding:14px 32px;font-family:'DM Sans',sans-serif;font-size:.8rem;letter-spacing:3px;text-transform:uppercase;text-decoration:none;border-radius:2px">Rebid Now →</a>
                <p style="margin:20px 0 0;font-size:11px;color:#7b9fd4">Only the winner gets charged. — Volleyball Collective</p>
              </div>
            `,
          }).catch(() => {});
        }
      }
    } catch {}

    return res.status(200).json({ success: true, newBidId: newBid.id, newAmount });
  } catch (err) {
    console.error('auto-bid error:', err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
};
