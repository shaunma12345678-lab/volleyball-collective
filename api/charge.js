const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

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

  const ADMIN_PW = process.env.ADMIN_PASSWORD || 'vb2024';
  const { paymentMethodId, amount, email, name, adminPw } = req.body || {};

  if (adminPw !== ADMIN_PW) return res.status(403).json({ error: 'Unauthorized' });
  if (!paymentMethodId || !amount) return res.status(400).json({ error: 'Missing fields' });

  try {
    const amountCents = Math.round(parseFloat(amount) * 100);
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      payment_method: paymentMethodId,
      confirm: true,
      receipt_email: email,
      description: `Volleyball Collective — bid by ${name}`,
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    });
    return res.status(200).json({ success: true, paymentIntentId: paymentIntent.id });
  } catch (err) {
    console.error('charge error:', err);
    return res.status(500).json({ error: err.message });
  }
};
