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

module.exports = async (req, res) => {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { dropId, email } = req.body || {};
  if (!dropId) return res.status(400).json({ error: 'dropId is required' });
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: 'Please enter a valid email address' });

  const cleanEmail = email.toLowerCase().trim();

  try {
    // Record per-drop waitlist (admin can see demand count per item)
    await redis('SADD', `notify:${dropId}`, cleanEmail);

    // Auto-subscribe to drop alerts if not already on the list
    const existing = await redis('GET', `emailsub:${cleanEmail}`);
    if (!existing) {
      const unsubToken = crypto.randomBytes(16).toString('hex');
      await redis('SET', `emailsub:${cleanEmail}`, JSON.stringify({
        email: cleanEmail,
        subscribedAt: new Date().toISOString(),
        autoSubscribed: true,
        unsubToken,
      }));
      await redis('SADD', 'emailsubs:all', cleanEmail);
      await redis('SET', `unsub:${unsubToken}`, cleanEmail);
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('notify error:', err);
    return res.status(500).json({ error: err.message });
  }
};
