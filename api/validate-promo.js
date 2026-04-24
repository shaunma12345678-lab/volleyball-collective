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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const code = (req.query.code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ valid: false, error: 'No code provided' });

  try {
    const raw = await redis('GET', `promo:${code}`);
    if (!raw) return res.status(200).json({ valid: false, error: 'Invalid or expired code' });

    const promo = JSON.parse(raw);
    if (!promo.active) return res.status(200).json({ valid: false, error: 'This code is no longer active' });

    return res.status(200).json({ valid: true, discount: promo.discount, label: promo.label });
  } catch (err) {
    console.error('validate-promo error:', err);
    return res.status(500).json({ valid: false, error: 'Could not validate code' });
  }
};
