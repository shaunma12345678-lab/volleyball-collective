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

async function rewardReferrer(usedCode) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_PASS) return;
  const promoRaw = await redis('GET', `promo:${usedCode}`);
  if (!promoRaw) return;
  const promo = JSON.parse(promoRaw);
  if (promo.type !== 'referral' || !promo.ownerEmail) return;

  const rewardCode = 'REWARD' + crypto.randomBytes(3).toString('hex').toUpperCase();
  await redis('SET', `promo:${rewardCode}`, JSON.stringify({
    code: rewardCode,
    label: `Reward — ${promo.ownerName}`,
    discount: 10,
    active: true,
    maxUses: 1,
    buyNowUses: 0,
    bidUses: 0,
    buyNowRevenue: 0,
    bidRevenue: 0,
    type: 'reward',
    createdAt: new Date().toISOString(),
  }));
  await redis('SADD', 'promos:all', rewardCode);

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS },
  });
  let unsubUrl = 'https://volleyball-collective.vercel.app/api/unsubscribe';
  try {
    const subRaw = await redis('GET', `emailsub:${promo.ownerEmail}`);
    if (subRaw) { const sub = JSON.parse(subRaw); if (sub.unsubToken) unsubUrl += `?t=${sub.unsubToken}`; }
  } catch {}
  await transporter.sendMail({
    from: `"Volleyball Collective" <${process.env.GMAIL_USER}>`,
    to: promo.ownerEmail,
    subject: `Someone used your referral code — here's your reward!`,
    html: `
      <div style="font-family:'DM Sans',Helvetica,Arial,sans-serif;max-width:500px;margin:0 auto;background:#00154F;color:#F5F0E8;padding:36px 32px;border-radius:6px">
        <div style="font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#ED2939;margin-bottom:8px">Volleyball Collective</div>
        <h2 style="font-size:24px;margin:0 0 16px;font-weight:700">Your referral paid off. 🏐</h2>
        <p style="margin:0 0 20px;line-height:1.6;color:#7b9fd4">Someone used your referral code to make a purchase. As promised — here's 10% off your next order:</p>
        <div style="background:rgba(62,207,142,.08);border:1px solid rgba(62,207,142,.25);border-radius:4px;padding:20px;text-align:center;margin:0 0 20px">
          <div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#7b9fd4;margin-bottom:8px">Your Reward Code</div>
          <div style="font-family:monospace;font-size:26px;font-weight:700;letter-spacing:3px;color:#3ecf8e">${rewardCode}</div>
          <div style="font-size:11px;color:#7b9fd4;margin-top:8px">10% off · One-time use</div>
        </div>
        <a href="https://volleyball-collective.vercel.app" style="display:inline-block;background:#ED2939;color:#fff;padding:14px 32px;font-family:'DM Sans',sans-serif;font-size:.8rem;letter-spacing:3px;text-transform:uppercase;text-decoration:none;border-radius:2px">Shop The Drops →</a>
        <p style="margin:24px 0 0;font-size:11px;color:#7b9fd4">— Volleyball Collective</p>
        <p style="margin:12px 0 0;font-size:10px;color:#4a6fa0"><a href="${unsubUrl}" style="color:#4a6fa0">Unsubscribe</a></p>
      </div>
    `,
  });
}

const INTL_SHIPPING_FEE = 20;
const USA_VARIANTS = new Set(['usa', 'us', 'u.s.', 'u.s.a.', 'united states', 'united states of america']);
function isUSACountry(c) { return USA_VARIANTS.has((c || '').toLowerCase().trim()); }

async function sendPurchaseEmail(buyer, drop, baseCharged, shippingFee, discountPercent, referralCode) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_PASS) return;
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS },
  });
  const originalPrice = parseFloat(drop.price).toFixed(2);
  const totalCharged = (baseCharged + shippingFee).toFixed(2);
  const hasDiscount = discountPercent > 0;

  let unsubUrl = 'https://volleyball-collective.vercel.app/api/unsubscribe';
  try {
    const subRaw = await redis('GET', `emailsub:${buyer.email}`);
    if (subRaw) {
      const sub = JSON.parse(subRaw);
      if (sub.unsubToken) unsubUrl += `?t=${sub.unsubToken}`;
    }
  } catch {}

  await transporter.sendMail({
    from: `"Volleyball Collective" <${process.env.GMAIL_USER}>`,
    to: buyer.email,
    subject: `Your purchase of "${drop.name}" is confirmed!`,
    html: `
      <div style="font-family:'DM Sans',Helvetica,Arial,sans-serif;max-width:500px;margin:0 auto;background:#00154F;color:#F5F0E8;padding:36px 32px;border-radius:6px">
        <div style="font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#ED2939;margin-bottom:8px">Volleyball Collective</div>
        <h2 style="font-size:24px;margin:0 0 20px;font-weight:700">Purchase Confirmed!</h2>
        <p style="margin:0 0 12px">Hey <strong>${buyer.name}</strong>,</p>
        <p style="margin:0 0 20px;line-height:1.6">Your purchase of <strong>${drop.name}</strong> for <strong style="color:#ED2939;font-size:18px">$${totalCharged}</strong> has been confirmed and your card has been charged.</p>
        <table style="font-size:13px;width:100%;border-collapse:collapse">
          <tr><td style="padding:6px 0;color:#7b9fd4">Item</td><td style="padding:6px 0;text-align:right">${drop.name}</td></tr>
          ${hasDiscount ? `<tr><td style="padding:6px 0;color:#7b9fd4">Original Price</td><td style="padding:6px 0;text-align:right;text-decoration:line-through;color:#7b9fd4">$${originalPrice}</td></tr><tr><td style="padding:6px 0;color:#7b9fd4">Ambassador Discount</td><td style="padding:6px 0;text-align:right;color:#3ecf8e">−${discountPercent}%</td></tr><tr><td style="padding:6px 0;color:#7b9fd4">Price After Discount</td><td style="padding:6px 0;text-align:right">$${baseCharged.toFixed(2)}</td></tr>` : ''}
          ${shippingFee > 0 ? `<tr><td style="padding:6px 0;color:#7b9fd4">International Shipping</td><td style="padding:6px 0;text-align:right">$${shippingFee.toFixed(2)}</td></tr>` : ''}
          <tr style="border-top:1px solid rgba(123,159,212,.2)"><td style="padding:8px 0 0;color:#7b9fd4;font-weight:700">Total Charged</td><td style="padding:8px 0 0;text-align:right;color:#ED2939;font-weight:700">$${totalCharged}</td></tr>
          ${buyer.address ? `<tr><td style="padding:6px 0;color:#7b9fd4">Ship To</td><td style="padding:6px 0;text-align:right">${buyer.address.street}, ${buyer.address.city} ${buyer.address.state} ${buyer.address.zip}${buyer.address.country && !isUSACountry(buyer.address.country) ? `, ${buyer.address.country}` : ''}</td></tr>` : ''}
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

  const { paymentMethodId, dropId, name, email, phone, address, promoCode } = req.body || {};
  if (!paymentMethodId || !dropId || !name || !email)
    return res.status(400).json({ error: 'Missing required fields' });

  try {
    const raw = await redis('GET', `drop:${dropId}`);
    if (!raw) return res.status(404).json({ error: 'Item not found' });
    const drop = JSON.parse(raw);

    if (drop.type !== 'buynow') return res.status(400).json({ error: 'This item is not available for Buy Now' });
    if (drop.status !== 'published') return res.status(400).json({ error: 'This item is no longer available' });
    if (drop.sold) return res.status(409).json({ error: 'This item has already been sold' });
    if (!drop.price || parseFloat(drop.price) < 1) return res.status(400).json({ error: 'Invalid item price' });

    // Validate promo code server-side — never trust client-supplied discount
    let discountPercent = 0;
    let appliedCode = null;
    if (promoCode) {
      const cleanCode = promoCode.trim().toUpperCase();
      const promoRaw = await redis('GET', `promo:${cleanCode}`);
      if (promoRaw) {
        const promo = JSON.parse(promoRaw);
        if (promo.active) {
          discountPercent = promo.discount;
          appliedCode = cleanCode;
        }
      }
    }

    const originalPrice = parseFloat(drop.price);
    const baseCharged = discountPercent > 0
      ? originalPrice * (1 - discountPercent / 100)
      : originalPrice;
    const shippingFee = address && !isUSACountry(address.country) ? INTL_SHIPPING_FEE : 0;
    const totalCharged = baseCharged + shippingFee;
    const amountCents = Math.round(totalCharged * 100);

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      payment_method: paymentMethodId,
      confirm: true,
      receipt_email: email,
      description: `Volleyball Collective — Buy Now: ${drop.name}${appliedCode ? ` (${appliedCode})` : ''}${shippingFee > 0 ? ' + intl shipping' : ''}`,
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    });

    // Increment promo code usage counter
    if (appliedCode) {
      const promoRaw = await redis('GET', `promo:${appliedCode}`);
      if (promoRaw) {
        const promo = JSON.parse(promoRaw);
        promo.buyNowUses = (promo.buyNowUses || 0) + 1;
        promo.buyNowRevenue = Math.round(((promo.buyNowRevenue || 0) + totalCharged) * 100) / 100;
        const totalUsesNow = promo.buyNowUses + (promo.bidUses || 0);
        if (promo.maxUses && totalUsesNow >= promo.maxUses) promo.active = false;
        await redis('SET', `promo:${appliedCode}`, JSON.stringify(promo));
      }
    }

    drop.sold = true;
    drop.soldTo = {
      name, email, phone: phone || null, address,
      purchasedAt: new Date().toISOString(),
      paymentIntentId: paymentIntent.id,
      promoCode: appliedCode || null,
      discountPercent: appliedCode ? discountPercent : 0,
      shippingFee: shippingFee,
      chargedPrice: totalCharged.toFixed(2),
    };
    await redis('SET', `drop:${dropId}`, JSON.stringify(drop));

    autoSubscribeEmail(email.toLowerCase().trim()).catch(() => {});
    if (appliedCode) rewardReferrer(appliedCode).catch(() => {});
    try {
      const referralCode = await getOrCreateReferralCode(email.toLowerCase().trim(), name);
      await sendPurchaseEmail({ name, email, address }, drop, baseCharged, shippingFee, discountPercent, referralCode);
    } catch (e) { console.warn('Email failed:', e.message); }

    return res.status(200).json({ success: true, paymentIntentId: paymentIntent.id });
  } catch (err) {
    console.error('purchase error:', err);
    return res.status(500).json({ error: err.message });
  }
};
