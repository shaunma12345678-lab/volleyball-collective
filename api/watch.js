async function redis(...args) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis not configured');
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
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { dropId } = req.body || {};
  if (!dropId) return res.status(400).json({ error: 'dropId required' });

  try {
    const [count] = await Promise.all([
      redis('INCR', `watch:${dropId}`),
      redis('INCR', `watch:1h:${dropId}`).then(c =>
        redis('EXPIRE', `watch:1h:${dropId}`, 3600).then(() => c)
      ),
    ]);
    return res.status(200).json({ count });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
