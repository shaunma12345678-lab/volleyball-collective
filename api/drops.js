async function redis(...args) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Database not configured — add UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in Vercel environment variables');
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
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
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
}

module.exports = async (req, res) => {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ADMIN_PW = process.env.ADMIN_PASSWORD || 'vb2024';

  try {
    if (req.method === 'GET') {
      const ids = (await redis('SMEMBERS', 'drops:keys')) || [];
      const drops = (
        await Promise.all(
          ids.map(async (id) => {
            const raw = await redis('GET', `drop:${id}`);
            try { return JSON.parse(raw); } catch { return null; }
          })
        )
      )
        .filter(Boolean)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      return res.status(200).json({ drops });
    }

    const body = req.body || {};

    if (req.method === 'POST') {
      if (body.adminPw !== ADMIN_PW)
        return res.status(403).json({ error: 'Unauthorized' });
      if (!body.drop || !body.drop.id || !body.drop.name)
        return res.status(400).json({ error: 'drop.id and drop.name are required' });
      const existing = await redis('GET', `drop:${body.drop.id}`);
      if (existing)
        return res.status(409).json({ error: 'Drop with this id already exists' });
      await redis('SET', `drop:${body.drop.id}`, JSON.stringify(body.drop));
      await redis('SADD', 'drops:keys', body.drop.id);
      return res.status(200).json({ success: true });
    }

    if (req.method === 'PUT') {
      if (body.adminPw !== ADMIN_PW)
        return res.status(403).json({ error: 'Unauthorized' });
      const raw = await redis('GET', `drop:${body.id}`);
      if (!raw)
        return res.status(404).json({ error: 'Drop not found' });
      const drop = JSON.parse(raw);
      drop.status = drop.status === 'published' ? 'archived' : 'published';
      await redis('SET', `drop:${body.id}`, JSON.stringify(drop));
      return res.status(200).json({ success: true });
    }

    if (req.method === 'DELETE') {
      if (body.adminPw !== ADMIN_PW)
        return res.status(403).json({ error: 'Unauthorized' });
      await redis('DEL', `drop:${body.id}`);
      await redis('SREM', 'drops:keys', body.id);
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('drops error:', err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
};
