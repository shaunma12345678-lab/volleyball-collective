const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const EARLY_BIRD_LIMIT = 200;

async function redis(...args) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Database not configured — add UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN');
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

module.exports = async (req, res) => {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const earlyPriceId = process.env.STRIPE_PRICE_EARLY_ID;
  const standardPriceId = process.env.STRIPE_PRICE_STANDARD_ID;

  if (!earlyPriceId || !standardPriceId) {
    return res.status(500).json({
      error: 'Subscription not configured — add STRIPE_PRICE_EARLY_ID and STRIPE_PRICE_STANDARD_ID to Vercel environment variables',
    });
  }

  const { email, name } = req.body || {};
  if (!email || !name) return res.status(400).json({ error: 'Name and email are required' });

  const normalizedEmail = email.toLowerCase().trim();

  try {
    // Block re-subscription if already active
    const existing = await redis('GET', `subscriber:${normalizedEmail}`);
    if (existing) {
      const sub = JSON.parse(existing);
      if (sub.status === 'active') {
        return res.status(409).json({ error: 'This email already has an active membership' });
      }
    }

    // Determine price tier at checkout time — stored in metadata so webhook uses same value
    const totalRaw = await redis('GET', 'subscribers:total');
    const total = parseInt(totalRaw || '0', 10);
    const isEarlyBird = total < EARLY_BIRD_LIMIT;
    const priceId = isEarlyBird ? earlyPriceId : standardPriceId;
    const planLabel = isEarlyBird ? '9.99' : '11.99';
    const spotsLeft = isEarlyBird ? EARLY_BIRD_LIMIT - total : 0;

    // Derive base URL from request headers — works on any Vercel deployment automatically
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
    const baseUrl = `${proto}://${host}`;

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: normalizedEmail,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${baseUrl}/?subscribed=true&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/?subscribe=cancelled`,
      metadata: { name: name.trim(), email: normalizedEmail, plan: planLabel },
      subscription_data: {
        metadata: { name: name.trim(), email: normalizedEmail, plan: planLabel },
      },
    });

    return res.status(200).json({ url: session.url, planLabel, isEarlyBird, spotsLeft });
  } catch (err) {
    console.error('subscribe error:', err);
    return res.status(500).json({ error: err.message });
  }
};
