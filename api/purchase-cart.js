const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
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

const INTL_SHIPPING_FEE = 20;
const USA_VARIANTS = new Set(['usa', 'us', 'u.s.', 'u.s.a.', 'united states', 'united states of america']);
function isUSACountry(c) { return USA_VARIANTS.has((c || '').toLowerCase().trim()); }

async function autoSubscribeEmail(email) {
  const existing = await redis('GET', `emailsub:${email}`);
  if (existing) return;
  const unsubToken = crypto.randomBytes(16).toString('hex');
  await redis('SET', `emailsub:${email}`, JSON.stringify({
    email, subscribedAt: new Date().toISOString(), autoSubscribed: true, unsubToken,
  }));
  await redis('SADD', 'emailsubs:all', email);
  await redis('SET', `unsub:${unsubToken}`, email);
}

async function getOrCreateReferralCode(email, name) {
  const existing = await redis('GET', `ref-owner:${email}`);
  if (existing) return existing;
  const code = 'REF' + crypto.randomBytes(3).toString('hex').toUpperCase();
  await redis('SET', `promo:${code}`, JSON.stringify({
    code, label: `Referral — ${name}`, ownerEmail: email, ownerName: name,
    discount: 10, active: true, maxUses: null,
    buyNowUses: 0, bidUses: 0, buyNowRevenue: 0, bidRevenue: 0,
    type: 'referral', createdAt: new Date().toISOString(),
  }));
  await redis('SADD', 'promos:all', code);
  await redis('SET', `ref-owner:${email}`, code);
  return code;
}

async function sendCartEmail(buyer, items, totalCharged, shippingFee, referralCode) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_PASS) return;
  const t = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS },
  });

  let unsubUrl = 'https://volleyball-collective.vercel.app/api/unsubscribe';
  try {
    const subRaw = await redis('GET', `emailsub:${buyer.email}`);
    if (subRaw) { const sub = JSON.parse(subRaw); if (sub.unsubToken) unsubUrl += `?t=${sub.unsubToken}`; }
  } catch {}

  const itemRows = items.map(item =>
    `<tr><td style="padding:6px 0;color:#7b9fd4">${item.name}</td><td style="padding:6px 0;text-align:right">$${parseFloat(item.price).toFixed(2)}</td></tr>`
  ).join('');

  await t.sendMail({
    from: `"Volleyball Collective" <${process.env.GMAIL_USER}>`,
    to: buyer.email,
    subject: `Your order (${items.length} item${items.length > 1 ? 's' : ''}) is confirmed!`,
    html: `
      <div style="font-family:'DM Sans',Helvetica,Arial,sans-serif;max-width:500px;margin:0 auto;background:#00154F;color:#F5F0E8;padding:36px 32px;border-radius:6px">
        <div style="font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#ED2939;margin-bottom:8px">Volleyball Collective</div>
        <h2 style="font-size:24px;margin:0 0 20px;font-weight:700">Order Confirmed!</h2>
        <p style="margin:0 0 12px">Hey <strong>${buyer.name}</strong>,</p>
        <p style="margin:0 0 20px;line-height:1.6">Your order of <strong>${items.length} item${items.length > 1 ? 's' : ''}</strong> has been confirmed and your card charged <strong style="color:#ED2939">$${parseFloat(totalCharged).toFixed(2)}</strong>.</p>
        <table style="font-size:13px;width:100%;border-collapse:collapse">
          ${itemRows}
          ${shippingFee > 0 ? `<tr><td style="padding:6px 0;color:#7b9fd4">International Shipping</td><td style="padding:6px 0;text-align:right">$${parseFloat(shippingFee).toFixed(2)}</td></tr>` : ''}
          <tr style="border-top:1px solid rgba(123,159,212,.2)"><td style="padding:8px 0 0;color:#7b9fd4;font-weight:700">Total Charged</td><td style="padding:8px 0 0;text-align:right;color:#3ecf8e;font-weight:700">$${parseFloat(totalCharged).toFixed(2)}</td></tr>
        </table>
        ${referralCode ? `
        <div style="background:rgba(62,207,142,.08);border:1px solid rgba(62,207,142,.2);border-radius:4px;padding:18px;margin:20px 0">
          <div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#7b9fd4;margin-bottom:8px">Your Referral Code</div>
          <div style="font-family:monospace;font-size:22px;font-weight:700;letter-spacing:3px;color:#3ecf8e">${referralCode}</div>
          <div style="font-size:12px;color:#7b9fd4;margin-top:8px;line-height:1.5">Share with friends — they get 10% off, you earn a reward when they buy.</div>
        </div>` : ''}
        <p style="margin:20px 0 0;font-size:11px;color:#7b9fd4">We'll be in touch with shipping details. — Volleyball Collective</p>
        <p style="margin:12px 0 0;font-size:10px;color:#4a6fa0">You're on our drop alert list. <a href="${unsubUrl}" style="color:#4a6fa0">Unsubscribe</a></p>
      </div>
    `,
  });
}

module.exports = async (req, res) => {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { paymentMethodId, dropIds, name, email, phone, address } = req.body || {};
  if (!paymentMethodId || !Array.isArray(dropIds) || !dropIds.length || !name || !email)
    return res.status(400).json({ error: 'Missing required fields' });

  try {
    // Load and validate all drops
    const drops = await Promise.all(dropIds.map(async id => {
      const raw = await redis('GET', `drop:${id}`);
      if (!raw) throw new Error(`Item ${id} not found`);
      return JSON.parse(raw);
    }));

    for (const drop of drops) {
      if (!['buynow', 'bundle', 'flash'].includes(drop.type))
        return res.status(400).json({ error: `"${drop.name}" is not available for purchase` });
      if (drop.status !== 'published')
        return res.status(400).json({ error: `"${drop.name}" is no longer available` });
      if (drop.sold)
        return res.status(409).json({ error: `"${drop.name}" was just sold — please remove it from your cart` });
      if (!drop.price || parseFloat(drop.price) < 1)
        return res.status(400).json({ error: `Invalid price for "${drop.name}"` });
    }

    const itemsTotal = drops.reduce((sum, d) => sum + parseFloat(d.price), 0);
    const shippingFee = address && !isUSACountry(address.country) ? INTL_SHIPPING_FEE : 0;
    const totalCharged = itemsTotal + shippingFee;
    const amountCents = Math.round(totalCharged * 100);

    const desc = drops.map(d => d.name).join(', ');
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      payment_method: paymentMethodId,
      confirm: true,
      receipt_email: email,
      description: `Volleyball Collective — Cart: ${desc}${shippingFee > 0 ? ' + intl shipping' : ''}`,
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    });

    // Mark all drops as sold
    const purchasedAt = new Date().toISOString();
    await Promise.all(drops.map(async drop => {
      drop.sold = true;
      drop.soldTo = {
        name, email, phone: phone || null, address,
        purchasedAt,
        paymentIntentId: paymentIntent.id,
        chargedPrice: parseFloat(drop.price).toFixed(2),
        shippingFee: 0,
        cartOrder: true,
      };
      await redis('SET', `drop:${drop.id}`, JSON.stringify(drop));
    }));

    autoSubscribeEmail(email.toLowerCase().trim()).catch(() => {});
    try {
      const referralCode = await getOrCreateReferralCode(email.toLowerCase().trim(), name);
      await sendCartEmail(
        { name, email, address },
        drops.map(d => ({ name: d.name, price: d.price })),
        totalCharged,
        shippingFee,
        referralCode
      );
    } catch (e) { console.warn('Cart email failed:', e.message); }

    return res.status(200).json({ success: true, paymentIntentId: paymentIntent.id });
  } catch (err) {
    console.error('purchase-cart error:', err);
    return res.status(500).json({ error: err.message });
  }
};
