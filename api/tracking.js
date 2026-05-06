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

function getTrackingUrl(carrier, number) {
  const n = encodeURIComponent(number);
  const map = {
    USPS: `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`,
    UPS: `https://www.ups.com/track?tracknum=${n}`,
    FedEx: `https://www.fedex.com/fedextrack/?trknbr=${n}`,
    DHL: `https://www.dhl.com/en/express/tracking.html?AWB=${n}`,
  };
  return map[carrier] || null;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { bidId, trackingNumber, carrier, adminPw } = req.body || {};

  const authErr = await checkAdminAuth(req, adminPw);
  if (authErr) return res.status(authErr.status).json(authErr.json);

  if (!bidId || !trackingNumber || !trackingNumber.trim())
    return res.status(400).json({ error: 'bidId and trackingNumber are required' });

  try {
    const bidRaw = await redis('GET', `bid:${bidId}`);
    if (!bidRaw) return res.status(404).json({ error: 'Bid not found' });
    const bid = JSON.parse(bidRaw);

    const dropRaw = await redis('GET', `drop:${bid.dropId}`);
    const drop = dropRaw ? JSON.parse(dropRaw) : null;
    const dropName = drop ? drop.name : 'your item';

    bid.trackingNumber = trackingNumber.trim();
    bid.trackingCarrier = carrier || '';
    await redis('SET', `bid:${bidId}`, JSON.stringify(bid));

    if (!process.env.GMAIL_USER || !process.env.GMAIL_PASS)
      return res.status(200).json({ success: true, emailSent: false });

    const trackUrl = getTrackingUrl(carrier, trackingNumber.trim());
    const carrierLabel = carrier && carrier !== 'Other' ? carrier : 'your carrier';

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS },
    });

    await transporter.sendMail({
      from: `"Volleyball Collective" <${process.env.GMAIL_USER}>`,
      to: bid.email,
      subject: `📦 Your ${dropName} is on the way!`,
      html: `
        <div style="font-family:'DM Sans',Helvetica,Arial,sans-serif;max-width:500px;margin:0 auto;background:#00154F;color:#F5F0E8;padding:36px 32px;border-radius:6px">
          <div style="font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#ED2939;margin-bottom:8px">Volleyball Collective · Shipping Update</div>
          <h2 style="font-size:24px;margin:0 0 8px;font-weight:700">Your order is on its way 📦</h2>
          <p style="margin:0 0 24px;color:#7b9fd4;font-size:.9rem">Hey <strong style="color:#F5F0E8">${bid.name}</strong>, great news — <strong style="color:#F5F0E8">${dropName}</strong> has shipped and is heading to you.</p>

          <div style="background:rgba(62,207,142,.08);border:1px solid rgba(62,207,142,.25);border-radius:4px;padding:20px 24px;margin-bottom:24px">
            <div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#3ecf8e;margin-bottom:10px">Tracking Info</div>
            <div style="font-size:22px;font-weight:700;letter-spacing:2px;color:#F5F0E8;font-family:monospace;margin-bottom:6px">${trackingNumber.trim()}</div>
            <div style="font-size:.8rem;color:#7b9fd4">Carrier: <strong style="color:#F5F0E8">${carrierLabel}</strong></div>
          </div>

          ${trackUrl ? `<a href="${trackUrl}" style="display:inline-block;background:#ED2939;color:#fff;padding:14px 32px;font-family:'DM Sans',sans-serif;font-size:.8rem;letter-spacing:3px;text-transform:uppercase;text-decoration:none;border-radius:2px;margin-bottom:24px">Track Your Package →</a>` : ''}

          <p style="margin:0 0 6px;font-size:.8rem;color:#7b9fd4">Shipping to:</p>
          <p style="margin:0 0 24px;font-size:.85rem;color:#F5F0E8;line-height:1.6">${bid.address ? `${bid.address.street}<br>${bid.address.city}, ${bid.address.state} ${bid.address.zip}<br>${bid.address.country || ''}` : '—'}</p>

          <p style="margin:0;font-size:.75rem;color:#4a6fa0;line-height:1.6">Questions? Reply to this email. Thanks for bidding on Volleyball Collective — enjoy the jersey! 🏐</p>
        </div>
      `,
    });

    return res.status(200).json({ success: true, emailSent: true });
  } catch (err) {
    console.error('tracking error:', err);
    return res.status(500).json({ error: err.message });
  }
};
