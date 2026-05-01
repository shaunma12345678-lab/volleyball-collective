const nodemailer = require('nodemailer');
const crypto = require('crypto');
const { checkAdminAuth } = require('./_adminAuth');

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

async function autoSubscribeEmail(email) {
  const existing = await redis('GET', `emailsub:${email}`);
  if (existing) return;
  const unsubToken = crypto.randomBytes(16).toString('hex');
  await redis('SET', `emailsub:${email}`, JSON.stringify({
    email,
    subscribedAt: new Date().toISOString(),
    autoSubscribed: true,
    unsubToken,
  }));
  await redis('SADD', 'emailsubs:all', email);
  await redis('SET', `unsub:${unsubToken}`, email);
}

async function getOrCreateReferralCode(email, name) {
  const existing = await redis('GET', `ref-owner:${email}`);
  if (existing) return existing;
  const code = 'REF' + crypto.randomBytes(3).toString('hex').toUpperCase();
  await redis('SET', `promo:${code}`, JSON.stringify({
    code,
    label: `Referral — ${name}`,
    ownerEmail: email,
    ownerName: name,
    discount: 10,
    active: true,
    maxUses: null,
    buyNowUses: 0,
    bidUses: 0,
    buyNowRevenue: 0,
    bidRevenue: 0,
    type: 'referral',
    createdAt: new Date().toISOString(),
  }));
  await redis('SADD', 'promos:all', code);
  await redis('SET', `ref-owner:${email}`, code);
  return code;
}

// Single transport per function invocation — avoids re-establishing SMTP connection for every email
function makeTransport() {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS },
    pool: true,
    maxConnections: 1,
  });
}

// Emails every outbid bidder (all lower bids), not just the previous top
async function sendOutbidEmails(outbidBids, newBidAmount, dropName) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_PASS || !outbidBids.length) return;
  const t = makeTransport();
  for (const prevBid of outbidBids) {
    let unsubUrl = 'https://volleyball-collective.vercel.app/api/unsubscribe';
    try {
      const subRaw = await redis('GET', `emailsub:${prevBid.email.toLowerCase().trim()}`);
      if (subRaw) { const sub = JSON.parse(subRaw); if (sub.unsubToken) unsubUrl += `?t=${sub.unsubToken}`; }
    } catch {}
    t.sendMail({
      from: `"Volleyball Collective" <${process.env.GMAIL_USER}>`,
      to: prevBid.email,
      subject: `You've been outbid on "${dropName}"`,
      html: `
        <div style="font-family:'DM Sans',Helvetica,Arial,sans-serif;max-width:500px;margin:0 auto;background:#00154F;color:#F5F0E8;padding:36px 32px;border-radius:6px">
          <div style="font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#ED2939;margin-bottom:8px">Volleyball Collective</div>
          <h2 style="font-size:26px;margin:0 0 16px;font-weight:700">You've been outbid.</h2>
          <p style="margin:0 0 12px">Hey <strong>${prevBid.name}</strong>,</p>
          <p style="margin:0 0 20px;line-height:1.6">Someone just topped your bid on <strong>${dropName}</strong>. Get back in before it's gone.</p>
          <div style="background:rgba(255,255,255,.05);border-radius:4px;padding:14px 18px;margin-bottom:20px;font-size:13px;line-height:1.6">
            Your bid: <strong>$${parseFloat(prevBid.amount).toFixed(2)}</strong><br>
            New top bid: <strong style="color:#ED2939">$${parseFloat(newBidAmount).toFixed(2)}</strong>
          </div>
          <a href="https://volleyball-collective.vercel.app/#drops" style="display:inline-block;background:#ED2939;color:#fff;padding:14px 32px;font-family:'DM Sans',sans-serif;font-size:.8rem;letter-spacing:3px;text-transform:uppercase;text-decoration:none;border-radius:2px">Rebid Now →</a>
          <p style="margin:24px 0 0;font-size:12px;color:#7b9fd4">Only the winner gets charged. Everyone else owes $0. — Volleyball Collective</p>
          <p style="margin:10px 0 0;font-size:10px;color:#4a6fa0"><a href="${unsubUrl}" style="color:#4a6fa0">Unsubscribe</a></p>
        </div>
      `,
    }).catch(e => console.warn(`Outbid email failed for ${prevBid.email}:`, e.message));
  }
}

async function sendConfirmationEmail(bid, dropName, referralCode) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_PASS) return;
  const transporter = makeTransport();
  const discount = bid.promoDiscount || 0;

  let unsubUrl = 'https://volleyball-collective.vercel.app/api/unsubscribe';
  try {
    const subRaw = await redis('GET', `emailsub:${bid.email}`);
    if (subRaw) {
      const sub = JSON.parse(subRaw);
      if (sub.unsubToken) unsubUrl += `?t=${sub.unsubToken}`;
    }
  } catch {}

  const referralSection = referralCode ? `
    <div style="background:rgba(62,207,142,.08);border:1px solid rgba(62,207,142,.2);border-radius:4px;padding:18px;margin:20px 0">
      <div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#7b9fd4;margin-bottom:8px">Your Referral Code</div>
      <div style="font-family:monospace;font-size:22px;font-weight:700;letter-spacing:3px;color:#3ecf8e">${referralCode}</div>
      <div style="font-size:12px;color:#7b9fd4;margin-top:8px;line-height:1.5">Share this with friends. When they use it at checkout, they get 10% off — and you earn a reward on your next purchase.</div>
    </div>` : '';

  await transporter.sendMail({
    from: `"Volleyball Collective" <${process.env.GMAIL_USER}>`,
    to: bid.email,
    subject: `Your bid on "${dropName}" is secured!`,
    html: `
      <div style="font-family:'DM Sans',Helvetica,Arial,sans-serif;max-width:500px;margin:0 auto;background:#00154F;color:#F5F0E8;padding:36px 32px;border-radius:6px">
        <div style="font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#ED2939;margin-bottom:8px">Volleyball Collective</div>
        <h2 style="font-size:24px;margin:0 0 20px;font-weight:700">Your bid is locked in</h2>
        <p style="margin:0 0 12px">Hey <strong>${bid.name}</strong>,</p>
        <p style="margin:0 0 20px;line-height:1.6">Your bid on <strong>${dropName}</strong> has been recorded and your card is saved securely via Stripe.</p>
        <div style="background:rgba(255,255,255,0.06);border-left:3px solid #ED2939;padding:14px 18px;border-radius:3px;margin-bottom:20px">
          <p style="margin:0;font-size:13px;line-height:1.6"><strong>Your card is NOT charged yet.</strong><br>Only the winning bidder is charged — everyone else owes nothing.</p>
        </div>
        <table style="font-size:13px;width:100%;border-collapse:collapse">
          <tr><td style="padding:6px 0;color:#7b9fd4">Item</td><td style="padding:6px 0;text-align:right">${dropName}</td></tr>
          ${discount > 0 ? `<tr><td style="padding:6px 0;color:#7b9fd4">Ambassador Discount</td><td style="padding:6px 0;text-align:right;color:#3ecf8e">−${discount}% if you win</td></tr>` : ''}
          ${bid.address ? `<tr><td style="padding:6px 0;color:#7b9fd4">Ship To</td><td style="padding:6px 0;text-align:right">${bid.address.city}, ${bid.address.state}</td></tr>` : ''}
        </table>
        ${referralSection}
        <p style="margin:20px 0 0;font-size:11px;color:#7b9fd4">Good luck! — Volleyball Collective</p>
        <p style="margin:12px 0 0;font-size:10px;color:#4a6fa0">You're on our drop alert list. <a href="${unsubUrl}" style="color:#4a6fa0">Unsubscribe</a></p>
      </div>
    `,
  });
}

async function sendFirstBidEmail(bid, dropName, code) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_PASS) return;
  const transporter = makeTransport();
  let unsubUrl = 'https://volleyball-collective.vercel.app/api/unsubscribe';
  try {
    const subRaw = await redis('GET', `emailsub:${bid.email.toLowerCase().trim()}`);
    if (subRaw) { const sub = JSON.parse(subRaw); if (sub.unsubToken) unsubUrl += `?t=${sub.unsubToken}`; }
  } catch {}
  await transporter.sendMail({
    from: `"Volleyball Collective" <${process.env.GMAIL_USER}>`,
    to: bid.email,
    subject: `🥇 You were first — here's your exclusive 5% bid bonus`,
    html: `
      <div style="font-family:'DM Sans',Helvetica,Arial,sans-serif;max-width:500px;margin:0 auto;background:#00154F;color:#F5F0E8;padding:36px 32px;border-radius:6px">
        <div style="font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#ED2939;margin-bottom:8px">Volleyball Collective</div>
        <h2 style="font-size:24px;margin:0 0 16px;font-weight:700">You were first 🥇</h2>
        <p style="margin:0 0 12px">Hey <strong>${bid.name}</strong>,</p>
        <p style="margin:0 0 20px;line-height:1.6">You placed the very first bid on <strong>${dropName}</strong>. That takes guts — so here's a reward.</p>
        <div style="background:rgba(62,207,142,.08);border:1px solid rgba(62,207,142,.2);border-radius:4px;padding:18px;margin:20px 0;text-align:center">
          <div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#7b9fd4;margin-bottom:8px">Your Exclusive Code</div>
          <div style="font-family:monospace;font-size:26px;font-weight:700;letter-spacing:4px;color:#3ecf8e">${code}</div>
          <div style="font-size:12px;color:#7b9fd4;margin-top:10px;line-height:1.5">Use this code when you rebid on <strong>${dropName}</strong> to lock in <strong style="color:#3ecf8e">5% off</strong> your winning bid. One use only.</div>
        </div>
        <a href="https://volleyball-collective.vercel.app" style="display:inline-block;background:#ED2939;color:#fff;padding:14px 32px;font-family:'DM Sans',sans-serif;font-size:.8rem;letter-spacing:3px;text-transform:uppercase;text-decoration:none;border-radius:2px">Go Rebid With Code →</a>
        <p style="margin:24px 0 0;font-size:11px;color:#7b9fd4">Only the winner gets charged. — Volleyball Collective</p>
        <p style="margin:12px 0 0;font-size:10px;color:#4a6fa0"><a href="${unsubUrl}" style="color:#4a6fa0">Unsubscribe</a></p>
      </div>
    `,
  });
}

module.exports = async (req, res) => {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ADMIN_PW = process.env.ADMIN_PASSWORD;

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
      // Public response: minimal fields only + allow CDN caching
      res.setHeader('Cache-Control', 'public, s-maxage=10, stale-while-revalidate=30');
      return res.status(200).json({
        bids: bids.map(b => ({ id: b.id, dropId: b.dropId, amount: b.amount, createdAt: b.createdAt })),
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

      // Validate promo code server-side — increment bidUses if valid
      if (bid.promoCode) {
        const cleanCode = bid.promoCode.trim().toUpperCase();
        const promoRaw = await redis('GET', `promo:${cleanCode}`);
        if (promoRaw) {
          const promo = JSON.parse(promoRaw);
          if (promo.active) {
            bid.promoCode = cleanCode;
            bid.promoDiscount = promo.discount;
            promo.bidUses = (promo.bidUses || 0) + 1;
            const totalUsesNow = promo.bidUses + (promo.buyNowUses || 0);
            if (promo.maxUses && totalUsesNow >= promo.maxUses) promo.active = false;
            await redis('SET', `promo:${cleanCode}`, JSON.stringify(promo));
          } else {
            bid.promoCode = null;
            bid.promoDiscount = 0;
          }
        } else {
          bid.promoCode = null;
          bid.promoDiscount = 0;
        }
      }

      // Check if this is the first bid on this drop (before saving)
      let isFirstBid = false;
      try {
        const allIds = (await redis('SMEMBERS', 'bids:keys')) || [];
        const existingDropBids = (await Promise.all(
          allIds.map(async id => {
            try { const raw = await redis('GET', `bid:${id}`); const b = JSON.parse(raw); return b.dropId === bid.dropId ? b : null; } catch { return null; }
          })
        )).filter(Boolean);
        isFirstBid = existingDropBids.length === 0;
      } catch (e) {
        console.warn('First bid check failed:', e.message);
      }

      await redis('SET', `bid:${bid.id}`, JSON.stringify(bid));
      await redis('SADD', 'bids:keys', bid.id);

      // Anti-sniping: if bid lands in final 5 minutes, push end time out by 5 minutes
      try {
        const dropRaw = await redis('GET', `drop:${bid.dropId}`);
        if (dropRaw) {
          const drop = JSON.parse(dropRaw);
          if (drop.endTime) {
            const msLeft = new Date(drop.endTime) - Date.now();
            if (msLeft > 0 && msLeft < 5 * 60 * 1000) {
              drop.endTime = new Date(Date.now() + 5 * 60 * 1000).toISOString();
              await redis('SET', `drop:${drop.id}`, JSON.stringify(drop));
            }
          }
        }
      } catch (e) {
        console.warn('Anti-snipe extension failed:', e.message);
      }

      autoSubscribeEmail(bid.email.toLowerCase().trim()).catch(() => {});

      // First-bid bonus: generate 5% off promo code and email the first bidder
      if (isFirstBid) {
        try {
          const dropRaw = await redis('GET', `drop:${bid.dropId}`);
          const dropName = dropRaw ? JSON.parse(dropRaw).name : 'this drop';
          const code = 'FIRST' + crypto.randomBytes(3).toString('hex').toUpperCase();
          await redis('SET', `promo:${code}`, JSON.stringify({
            code,
            label: `First Bid Bonus — ${dropName}`,
            ownerEmail: bid.email.toLowerCase().trim(),
            discount: 5,
            active: true,
            maxUses: 1,
            buyNowUses: 0,
            bidUses: 0,
            buyNowRevenue: 0,
            bidRevenue: 0,
            type: 'first-bid',
            createdAt: new Date().toISOString(),
          }));
          await redis('SADD', 'promos:all', code);
          sendFirstBidEmail(bid, dropName, code).catch(() => {});
        } catch (e) {
          console.warn('First bid bonus failed:', e.message);
        }
      }

      // Outbid detection — if new bid is highest, email ALL lower bidders (not just previous top)
      try {
        const allIds = (await redis('SMEMBERS', 'bids:keys')) || [];
        const dropBids = (await Promise.all(
          allIds.map(async (id) => {
            if (id === bid.id) return null;
            const raw = await redis('GET', `bid:${id}`);
            try { const b = JSON.parse(raw); return b.dropId === bid.dropId ? b : null; } catch { return null; }
          })
        )).filter(Boolean);

        if (dropBids.length > 0) {
          const newAmt = parseFloat(bid.amount);
          // Collect all distinct bidders whose best bid is now lower than the new bid
          const byEmail = {};
          for (const b of dropBids) {
            const key = b.email.toLowerCase().trim();
            if (key === bid.email.toLowerCase().trim()) continue; // don't email the new bidder about themselves
            if (!byEmail[key] || parseFloat(b.amount) > parseFloat(byEmail[key].amount)) byEmail[key] = b;
          }
          const outbidBids = Object.values(byEmail).filter(b => parseFloat(b.amount) < newAmt);
          if (outbidBids.length > 0) {
            const dropRaw = await redis('GET', `drop:${bid.dropId}`);
            const dropName = dropRaw ? JSON.parse(dropRaw).name : 'this drop';
            sendOutbidEmails(outbidBids, newAmt, dropName).catch(() => {});
          }
        }
      } catch (outbidErr) {
        console.warn('Outbid check failed (non-fatal):', outbidErr.message);
      }

      try {
        const dropRaw = await redis('GET', `drop:${bid.dropId}`);
        const dropName = dropRaw ? JSON.parse(dropRaw).name : 'this drop';
        const referralCode = await getOrCreateReferralCode(bid.email.toLowerCase().trim(), bid.name);
        await sendConfirmationEmail(bid, dropName, referralCode);
      } catch (emailErr) {
        console.warn('Email send failed (non-fatal):', emailErr.message);
      }

      return res.status(200).json({ success: true });
    }

    if (req.method === 'PUT') {
      const authErr = await checkAdminAuth(req, body.adminPw);
      if (authErr) return res.status(authErr.status).json(authErr.json);
      const raw = await redis('GET', `bid:${body.id}`);
      if (!raw) return res.status(404).json({ error: 'Bid not found' });
      const bid = JSON.parse(raw);
      bid.charged = true;
      await redis('SET', `bid:${body.id}`, JSON.stringify(bid));
      return res.status(200).json({ success: true });
    }

    if (req.method === 'DELETE') {
      const authErr = await checkAdminAuth(req, body.adminPw);
      if (authErr) return res.status(authErr.status).json(authErr.json);
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
