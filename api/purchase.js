const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
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

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
}

async function sendPurchaseEmail(buyer, drop) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_PASS) return;
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS },
  });
  await transporter.sendMail({
    from: `"Volleyball Collective" <${process.env.GMAIL_USER}>`,
    to: buyer.email,
    subject: `Your purchase of "${drop.name}" is confirmed!`,
    html: `
      <div style="font-family:'DM Sans',Helvetica,Arial,sans-serif;max-width:500px;margin:0 auto;background:#00154F;color:#F5F0E8;padding:36px 32px;border-radius:6px">
        <div style="font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#ED2939;margin-bottom:8px">Volleyball Collective</div>
        <h2 style="font-size:24px;margin:0 0 20px;font-weight:700">Purchase Confirmed!</h2>
        <p style="margin:0 0 12px">Hey <strong>${buyer.name}</strong>,</p>
        <p style="margin:0 0 20px;line-height:1.6">Your purchase of <strong>${drop.name}</strong> for <strong style="color:#ED2939;font-size:18px">$${parseFloat(drop.price).toFixed(2)}</strong> has been confirmed and your card has been charged.</p>
        <table style="font-size:13px;width:100%;border-collapse:collapse">
          <tr><td style="padding:6px 0;color:#7b9fd4">Item</td><td style="padding:6px 0;text-align:right">${drop.name}</td></tr>
          <tr><td style="padding:6px 0;color:#7b9fd4">Amount Charged</td><td style="padding:6px 0;text-align:right;color:#ED2939;font-weight:700">$${parseFloat(drop.price).toFixed(2)}</td></tr>
          ${buyer.address ? `<tr><td style="padding:6px 0;color:#7b9fd4">Ship To</td><td style="padding:6px 0;text-align:right">${buyer.address.city}, ${buyer.address.state}</td></tr>` : ''}
        </table>
        <p style="margin:24px 0 0;font-size:11px;color:#7b9fd4">We'll be in touch with shipping details. — Volleyball Collective</p>
      </div>
    `,
  });
}

module.exports = async (req, res) => {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { paymentMethodId, dropId, name, email, address } = req.body || {};
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

    const amountCents = Math.round(parseFloat(drop.price) * 100);
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      payment_method: paymentMethodId,
      confirm: true,
      receipt_email: email,
      description: `Volleyball Collective — Buy Now: ${drop.name}`,
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    });

    // Mark drop as sold so no one else can buy it
    drop.sold = true;
    drop.soldTo = { name, email, address, purchasedAt: new Date().toISOString(), paymentIntentId: paymentIntent.id };
    await redis('SET', `drop:${dropId}`, JSON.stringify(drop));

    try { await sendPurchaseEmail({ name, email, address }, drop); } catch (e) { console.warn('Email failed:', e.message); }

    return res.status(200).json({ success: true, paymentIntentId: paymentIntent.id });
  } catch (err) {
    console.error('purchase error:', err);
    return res.status(500).json({ error: err.message });
  }
};
