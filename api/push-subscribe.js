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

  if (req.method === 'POST') {
    const { subscription } = req.body || {};
    if (!subscription || !subscription.endpoint)
      return res.status(400).json({ error: 'Invalid subscription object' });

    try {
      const key = Buffer.from(subscription.endpoint).toString('base64').slice(0, 64);
      await redis('SET', `push-sub:${key}`, JSON.stringify(subscription));
      await redis('SADD', 'push-subs:all', key);
      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('push-subscribe POST error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === 'DELETE') {
    const { endpoint } = req.body || {};
    if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
    try {
      const key = Buffer.from(endpoint).toString('base64').slice(0, 64);
      await redis('DEL', `push-sub:${key}`);
      await redis('SREM', 'push-subs:all', key);
      return res.status(200).json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
