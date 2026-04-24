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

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
}

async function sendWinnerEmail({ email, name, originalAmount, chargedAmount, dropName, promoDiscount }) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_PASS) return;
  const t = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS },
  });
  const hasDiscount = promoDiscount > 0;
  await t.sendMail({
    from: `"Volleyball Collective" <${process.env.GMAIL_USER}>`,
    to: email,
    subject: `You won "${dropName}" — payment confirmed!`,
    html: `
      <div style="font-family:'DM Sans',Helvetica,Arial,sans-serif;max-width:500px;margin:0 auto;background:#00154F;color:#F5F0E8;padding:36px 32px;border-radius:6px">
        <div style="font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#ED2939;margin-bottom:8px">Volleyball Collective</div>
        <h2 style="font-size:24px;margin:0 0 20px;font-weight:700">You won!</h2>
        <p style="margin:0 0 12px">Hey <strong>${name}</strong>,</p>
        <p style="margin:0 0 20px;line-height:1.6">
          Congratulations — your bid on <strong>${dropName}</strong> won and your card has been charged
          <strong style="color:#ED2939">$${parseFloat(chargedAmount).toFixed(2)}</strong>.
        </p>
        <div style="background:rgba(62,207,142,.08);border-left:3px solid #3ecf8e;padding:14px 18px;border-radius:3px;margin-bottom:20px">
          <p style="margin:0;font-size:13px;line-height:1.8">
            We will be in touch shortly with shipping details.<br>
            Thank you for being part of Volleyball Collective.
          </p>
        </div>
        <table style="font-size:13px;width:100%;border-collapse:collapse">
          <tr><td style="padding:6px 0;color:#7b9fd4">Item</td><td style="padding:6px 0;text-align:right">${dropName}</td></tr>
          ${hasDiscount ? `<tr><td style="padding:6px 0;color:#7b9fd4">Winning Bid</td><td style="padding:6px 0;text-align:right;text-decoration:line-through;color:#7b9fd4">$${parseFloat(originalAmount).toFixed(2)}</td></tr><tr><td style="padding:6px 0;color:#7b9fd4">Ambassador Discount</td><td style="padding:6px 0;text-align:right;color:#3ecf8e">−${promoDiscount}%</td></tr>` : ''}
          <tr><td style="padding:6px 0;color:#7b9fd4">Amount Charged</td><td style="padding:6px 0;text-align:right;color:#3ecf8e;font-weight:700">$${parseFloat(chargedAmount).toFixed(2)}</td></tr>
        </table>
        <p style="margin:24px 0 0;font-size:11px;color:#7b9fd4">— Volleyball Collective</p>
      </div>
    `,
  });
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const PW = process.env.ADMIN_PASSWORD || 'vb2024';
  const { paymentMethodId, amount, email, name, dropName, adminPw, promoCode, promoDiscount } = req.body || {};

  if (adminPw !== PW) return res.status(403).json({ error: 'Unauthorized' });
  if (!paymentMethodId || !amount) return res.status(400).json({ error: 'Missing fields' });

  const originalAmount = parseFloat(amount);
  const discount = promoDiscount || 0;
  const chargedAmount = discount > 0 ? originalAmount * (1 - discount / 100) : originalAmount;
  const amountCents = Math.round(chargedAmount * 100);

  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      payment_method: paymentMethodId,
      confirm: true,
      receipt_email: email,
      description: `Volleyball Collective — bid by ${name}${promoCode ? ` (${promoCode})` : ''}`,
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    });

    // Track bid revenue on the promo code
    if (promoCode) {
      try {
        const cleanCode = promoCode.trim().toUpperCase();
        const promoRaw = await redis('GET', `promo:${cleanCode}`);
        if (promoRaw) {
          const promo = JSON.parse(promoRaw);
          promo.bidRevenue = Math.round(((promo.bidRevenue || 0) + chargedAmount) * 100) / 100;
          await redis('SET', `promo:${cleanCode}`, JSON.stringify(promo));
        }
      } catch (e) {
        console.warn('Could not update promo bid revenue:', e.message);
      }
    }

    try {
      await sendWinnerEmail({
        email, name,
        originalAmount: amount,
        chargedAmount,
        dropName: dropName || 'your item',
        promoDiscount: discount,
      });
    } catch (e) {
      console.warn('Winner email failed:', e.message);
    }

    return res.status(200).json({ success: true, paymentIntentId: paymentIntent.id });
  } catch (err) {
    console.error('charge error:', err);
    return res.status(500).json({ error: err.message });
  }
};
