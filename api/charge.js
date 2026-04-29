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

async function sendWinnerEmail({ email, name, originalAmount, chargedAmount, dropName, promoDiscount, shippingFee }) {
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
          ${hasDiscount ? `<tr><td style="padding:6px 0;color:#7b9fd4">Winning Bid</td><td style="padding:6px 0;text-align:right;text-decoration:line-through;color:#7b9fd4">$${parseFloat(originalAmount).toFixed(2)}</td></tr><tr><td style="padding:6px 0;color:#7b9fd4">Ambassador Discount</td><td style="padding:6px 0;text-align:right;color:#3ecf8e">−${promoDiscount}%</td></tr>` : `<tr><td style="padding:6px 0;color:#7b9fd4">Winning Bid</td><td style="padding:6px 0;text-align:right">$${parseFloat(originalAmount).toFixed(2)}</td></tr>`}
          ${shippingFee > 0 ? `<tr><td style="padding:6px 0;color:#7b9fd4">International Shipping</td><td style="padding:6px 0;text-align:right">$${parseFloat(shippingFee).toFixed(2)}</td></tr>` : ''}
          <tr style="border-top:1px solid rgba(123,159,212,.2)"><td style="padding:8px 0 0;color:#7b9fd4;font-weight:700">Total Charged</td><td style="padding:8px 0 0;text-align:right;color:#3ecf8e;font-weight:700">$${parseFloat(chargedAmount).toFixed(2)}</td></tr>
        </table>
        <p style="margin:24px 0 0;font-size:11px;color:#7b9fd4">— Volleyball Collective</p>
      </div>
    `,
  });
}

async function sendLoserEmails({ dropId, winnerBidId, dropName }) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_PASS || !dropId) return;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return;

  const ids = (await redis('SMEMBERS', 'bids:keys')) || [];
  const loserBids = (await Promise.all(
    ids.map(async id => {
      if (id === winnerBidId) return null;
      try {
        const raw = await redis('GET', `bid:${id}`);
        if (!raw) return null;
        const b = JSON.parse(raw);
        return b.dropId === dropId && b.email ? b : null;
      } catch { return null; }
    })
  )).filter(Boolean);

  if (!loserBids.length) return;

  const seenEmails = new Set();
  const t = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS },
  });

  for (const bid of loserBids) {
    const lowerEmail = bid.email.toLowerCase().trim();
    if (seenEmails.has(lowerEmail)) continue;
    seenEmails.add(lowerEmail);

    let unsubUrl = 'https://volleyball-collective.vercel.app/api/unsubscribe';
    try {
      const subRaw = await redis('GET', `emailsub:${lowerEmail}`);
      if (subRaw) { const sub = JSON.parse(subRaw); if (sub.unsubToken) unsubUrl += `?t=${sub.unsubToken}`; }
    } catch {}

    t.sendMail({
      from: `"Volleyball Collective" <${process.env.GMAIL_USER}>`,
      to: bid.email,
      subject: `You just missed out on "${dropName}" — but the next drop is coming`,
      html: `
        <div style="font-family:'DM Sans',Helvetica,Arial,sans-serif;max-width:500px;margin:0 auto;background:#00154F;color:#F5F0E8;padding:36px 32px;border-radius:6px">
          <div style="font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#ED2939;margin-bottom:8px">Volleyball Collective</div>
          <h2 style="font-size:24px;margin:0 0 16px;font-weight:700">You just missed out.</h2>
          <p style="margin:0 0 12px">Hey <strong>${bid.name}</strong>,</p>
          <p style="margin:0 0 20px;line-height:1.6">The auction for <strong>${dropName}</strong> has closed and another bidder took it home. Your card was never charged — you owe nothing.</p>
          <div style="background:rgba(237,41,57,.07);border-left:3px solid #ED2939;padding:14px 18px;border-radius:3px;margin-bottom:24px">
            <p style="margin:0;font-size:13px;line-height:1.7">The next drop is coming. You placed a bid — that puts you ahead of everyone who didn't. Be ready.</p>
          </div>
          <a href="https://volleyball-collective.vercel.app" style="display:inline-block;background:#ED2939;color:#fff;padding:14px 32px;font-family:'DM Sans',sans-serif;font-size:.8rem;letter-spacing:3px;text-transform:uppercase;text-decoration:none;border-radius:2px">See What's Next →</a>
          <p style="margin:24px 0 0;font-size:11px;color:#7b9fd4">— Volleyball Collective</p>
          <p style="margin:12px 0 0;font-size:10px;color:#4a6fa0"><a href="${unsubUrl}" style="color:#4a6fa0">Unsubscribe</a> from drop alerts</p>
        </div>
      `,
    }).catch(e => console.warn(`Loser email failed for ${bid.email}:`, e.message));
  }
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const PW = process.env.ADMIN_PASSWORD || 'vb2024';
  const { paymentMethodId, amount, email, name, dropName, adminPw, promoCode, promoDiscount, shippingFee, dropId, winnerBidId } = req.body || {};

  if (adminPw !== PW) return res.status(403).json({ error: 'Unauthorized' });
  if (!paymentMethodId || !amount) return res.status(400).json({ error: 'Missing fields' });

  const originalAmount = parseFloat(amount);
  const discount = promoDiscount || 0;
  const shipping = parseFloat(shippingFee) || 0;
  const bidAfterDiscount = discount > 0 ? originalAmount * (1 - discount / 100) : originalAmount;
  const chargedAmount = bidAfterDiscount + shipping;
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
        shippingFee: shipping,
      });
    } catch (e) {
      console.warn('Winner email failed:', e.message);
    }

    sendLoserEmails({ dropId, winnerBidId, dropName: dropName || 'this item' }).catch(e => console.warn('Loser emails failed:', e.message));

    return res.status(200).json({ success: true, paymentIntentId: paymentIntent.id });
  } catch (err) {
    console.error('charge error:', err);
    return res.status(500).json({ error: err.message });
  }
};
