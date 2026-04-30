const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
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

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { dropId, adminPw } = req.body || {};

  const authErr = await checkAdminAuth(req, adminPw);
  if (authErr) return res.status(authErr.status).json(authErr.json);
  if (!dropId) return res.status(400).json({ error: 'Missing dropId' });

  const raw = await redis('GET', `drop:${dropId}`);
  if (!raw) return res.status(404).json({ error: 'Drop not found' });

  const drop = JSON.parse(raw);
  if (!drop.sold || !drop.soldTo) return res.status(400).json({ error: 'This item has no recorded sale' });

  const { paymentIntentId } = drop.soldTo;
  if (!paymentIntentId) return res.status(400).json({ error: 'No payment intent on record — refund manually in Stripe dashboard' });

  try {
    const refund = await stripe.refunds.create({ payment_intent: paymentIntentId });
    if (refund.status !== 'succeeded' && refund.status !== 'pending') {
      return res.status(500).json({ error: `Stripe refund status: ${refund.status}` });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  drop.sold = false;
  drop.soldTo = null;
  drop.status = 'published';
  await redis('SET', `drop:${dropId}`, JSON.stringify(drop));

  return res.status(200).json({ success: true });
};
