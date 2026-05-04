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

module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    try {
      const raw = await redis('GET', 'schedule:upcoming');
      const all = raw ? JSON.parse(raw) : [];
      // strip dates more than 1 day in the past
      const cutoff = Date.now() - 86400000;
      const dates = all.filter(d => new Date(d.date).getTime() > cutoff);
      return res.status(200).json({ dates });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === 'PUT') {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const ADMIN_PW = process.env.ADMIN_PASSWORD;
    if (!body.adminPw || body.adminPw !== ADMIN_PW)
      return res.status(401).json({ error: 'Unauthorized' });

    if (!Array.isArray(body.dates))
      return res.status(400).json({ error: 'dates must be an array' });

    const cutoff = Date.now() - 3600000;
    const valid = body.dates
      .filter(d => d && d.date && new Date(d.date).getTime() > cutoff)
      .map(d => ({ date: d.date, label: (d.label || '').trim() }))
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    await redis('SET', 'schedule:upcoming', JSON.stringify(valid));
    return res.status(200).json({ success: true, dates: valid });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
