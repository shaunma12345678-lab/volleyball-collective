const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const nodemailer = require('nodemailer');
const crypto = require('crypto');
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

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
}

function makeTransport() {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS },
    pool: true,
    maxConnections: 1,
  });
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET — admin fetches all requests
  if (req.method === 'GET') {
    const authErr = await checkAdminAuth(req, (req.query || {}).adminPw);
    if (authErr) return res.status(authErr.status).json(authErr.json);
    const ids = (await redis('SMEMBERS', 'refund-reqs:all')) || [];
    const requests = (await Promise.all(
      ids.map(async id => {
        const raw = await redis('GET', `refund-req:${id}`);
        try { return JSON.parse(raw); } catch { return null; }
      })
    )).filter(Boolean).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return res.status(200).json({ requests });
  }

  // POST — buyer submits refund request
  if (req.method === 'POST') {
    const { bidId, email, reason } = req.body || {};
    if (!bidId || !email || !reason) return res.status(400).json({ error: 'Missing required fields' });
    if (reason.trim().length < 10) return res.status(400).json({ error: 'Please describe the issue in more detail' });

    const bidRaw = await redis('GET', `bid:${bidId}`);
    if (!bidRaw) return res.status(404).json({ error: 'Order not found. Please use the link from your winner email.' });
    const bid = JSON.parse(bidRaw);

    if (bid.email.toLowerCase().trim() !== email.toLowerCase().trim())
      return res.status(403).json({ error: 'Email does not match the order on record.' });
    if (!bid.charged)
      return res.status(400).json({ error: 'This bid has not been charged — no purchase to refund.' });

    const existing = await redis('GET', `refund-req-by-bid:${bidId}`);
    if (existing) return res.status(409).json({ error: 'A refund request for this order already exists.' });

    let dropName = 'Unknown item';
    try {
      const dropRaw = await redis('GET', `drop:${bid.dropId}`);
      if (dropRaw) dropName = JSON.parse(dropRaw).name;
    } catch {}

    const reqId = `rr_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const request = {
      id: reqId,
      bidId,
      dropId: bid.dropId,
      dropName,
      buyerEmail: email.toLowerCase().trim(),
      buyerName: bid.name,
      amount: bid.amount,
      reason: reason.trim(),
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    await redis('SET', `refund-req:${reqId}`, JSON.stringify(request));
    await redis('SADD', 'refund-reqs:all', reqId);
    await redis('SET', `refund-req-by-bid:${bidId}`, reqId);

    if (process.env.GMAIL_USER && process.env.GMAIL_PASS) {
      const t = makeTransport();
      t.sendMail({
        from: `"Volleyball Collective" <${process.env.GMAIL_USER}>`,
        to: process.env.GMAIL_USER,
        subject: `⚠️ Refund Request — ${dropName} (${bid.name})`,
        html: `
          <div style="font-family:'DM Sans',Helvetica,Arial,sans-serif;max-width:500px;margin:0 auto;background:#00154F;color:#F5F0E8;padding:36px 32px;border-radius:6px">
            <div style="font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#ED2939;margin-bottom:8px">Volleyball Collective Admin</div>
            <h2 style="font-size:22px;margin:0 0 16px;font-weight:700">New Refund Request</h2>
            <table style="font-size:13px;width:100%;border-collapse:collapse;margin-bottom:20px">
              <tr><td style="padding:5px 0;color:#7b9fd4;width:120px">Buyer</td><td><strong>${bid.name}</strong> (${email})</td></tr>
              <tr><td style="padding:5px 0;color:#7b9fd4">Item</td><td>${dropName}</td></tr>
              <tr><td style="padding:5px 0;color:#7b9fd4">Amount Paid</td><td style="color:#ED2939"><strong>$${parseFloat(bid.amount).toFixed(2)}</strong></td></tr>
              <tr><td style="padding:5px 0;color:#7b9fd4">Request ID</td><td style="font-size:.78rem;color:#7b9fd4">${reqId}</td></tr>
            </table>
            <div style="background:rgba(255,255,255,.05);border-left:3px solid #ED2939;padding:14px 18px;border-radius:3px;margin-bottom:20px">
              <div style="font-size:.68rem;letter-spacing:2px;text-transform:uppercase;color:#7b9fd4;margin-bottom:6px">Buyer's Explanation</div>
              <p style="margin:0;line-height:1.7;font-size:.9rem">${reason.trim()}</p>
            </div>
            <p style="font-size:.78rem;color:#7b9fd4;margin:0">Log into the admin panel → Refund Requests tab to approve or deny.</p>
          </div>
        `,
      }).catch(e => console.warn('Refund request admin email failed:', e.message));
    }

    return res.status(200).json({ success: true });
  }

  // PUT — admin approves or denies
  if (req.method === 'PUT') {
    const authErr = await checkAdminAuth(req, req.body?.adminPw);
    if (authErr) return res.status(authErr.status).json(authErr.json);
    const { reqId, action } = req.body || {};
    if (!reqId || !action) return res.status(400).json({ error: 'Missing reqId or action' });

    const raw = await redis('GET', `refund-req:${reqId}`);
    if (!raw) return res.status(404).json({ error: 'Request not found' });
    const request = JSON.parse(raw);

    if (action === 'approve') {
      const dropRaw = await redis('GET', `drop:${request.dropId}`);
      if (!dropRaw) return res.status(404).json({ error: 'Drop not found' });
      const drop = JSON.parse(dropRaw);
      if (!drop.sold || !drop.soldTo) return res.status(400).json({ error: 'No active sale found for this item' });
      const { paymentIntentId } = drop.soldTo;
      if (!paymentIntentId) return res.status(400).json({ error: 'No payment intent on record — refund manually in Stripe dashboard' });

      try {
        const refund = await stripe.refunds.create({ payment_intent: paymentIntentId });
        if (refund.status !== 'succeeded' && refund.status !== 'pending')
          return res.status(500).json({ error: `Stripe refund status: ${refund.status}` });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }

      drop.sold = false;
      drop.soldTo = null;
      drop.status = 'published';
      await redis('SET', `drop:${request.dropId}`, JSON.stringify(drop));

      request.status = 'approved';
      request.resolvedAt = new Date().toISOString();
      await redis('SET', `refund-req:${reqId}`, JSON.stringify(request));

      if (process.env.GMAIL_USER && process.env.GMAIL_PASS) {
        makeTransport().sendMail({
          from: `"Volleyball Collective" <${process.env.GMAIL_USER}>`,
          to: request.buyerEmail,
          subject: `Your refund for "${request.dropName}" has been approved`,
          html: `
            <div style="font-family:'DM Sans',Helvetica,Arial,sans-serif;max-width:500px;margin:0 auto;background:#00154F;color:#F5F0E8;padding:36px 32px;border-radius:6px">
              <div style="font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#ED2939;margin-bottom:8px">Volleyball Collective</div>
              <h2 style="font-size:24px;margin:0 0 16px;font-weight:700">Refund Approved</h2>
              <p style="margin:0 0 12px">Hey <strong>${request.buyerName}</strong>,</p>
              <p style="margin:0 0 20px;line-height:1.6">Your refund request for <strong>${request.dropName}</strong> has been approved. A full refund of <strong style="color:#3ecf8e">$${parseFloat(request.amount).toFixed(2)}</strong> has been issued to your original payment method.</p>
              <p style="margin:0;font-size:.78rem;color:#7b9fd4">Please allow 5–10 business days for the funds to appear. — Volleyball Collective</p>
            </div>
          `,
        }).catch(() => {});
      }

      return res.status(200).json({ success: true });
    }

    if (action === 'deny') {
      request.status = 'denied';
      request.resolvedAt = new Date().toISOString();
      await redis('SET', `refund-req:${reqId}`, JSON.stringify(request));

      if (process.env.GMAIL_USER && process.env.GMAIL_PASS) {
        makeTransport().sendMail({
          from: `"Volleyball Collective" <${process.env.GMAIL_USER}>`,
          to: request.buyerEmail,
          subject: `Update on your refund request for "${request.dropName}"`,
          html: `
            <div style="font-family:'DM Sans',Helvetica,Arial,sans-serif;max-width:500px;margin:0 auto;background:#00154F;color:#F5F0E8;padding:36px 32px;border-radius:6px">
              <div style="font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#ED2939;margin-bottom:8px">Volleyball Collective</div>
              <h2 style="font-size:24px;margin:0 0 16px;font-weight:700">Refund Request Update</h2>
              <p style="margin:0 0 12px">Hey <strong>${request.buyerName}</strong>,</p>
              <p style="margin:0 0 20px;line-height:1.6">After reviewing your request for <strong>${request.dropName}</strong>, we were unable to approve a refund at this time. If you have additional questions, reach out via Instagram <strong>@volleyballcollective</strong>.</p>
              <p style="margin:0;font-size:.78rem;color:#7b9fd4">— Volleyball Collective</p>
            </div>
          `,
        }).catch(() => {});
      }

      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: 'Invalid action — use approve or deny' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
