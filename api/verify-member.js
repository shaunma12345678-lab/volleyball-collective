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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email is required' });

  const cleanEmail = email.toLowerCase().trim();

  try {
    const raw = await redis('GET', `subscriber:${cleanEmail}`);
    if (!raw) return res.status(403).json({ error: 'No active membership found for this email' });

    const sub = JSON.parse(raw);
    if (sub.status !== 'active') return res.status(403).json({ error: 'Your membership is no longer active' });

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 24 * 60 * 60 * 1000;

    await redis('SET', `member-session:${token}`, cleanEmail);
    await redis('EXPIRE', `member-session:${token}`, 86400);

    return res.status(200).json({ token, expiresAt, name: sub.name });
  } catch (err) {
    console.error('verify-member error:', err);
    return res.status(500).json({ error: err.message });
  }
};
