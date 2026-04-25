const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'vb2024';

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

  // GET — list all promo codes (admin only)
  if (req.method === 'GET') {
    const adminPw = req.query.adminPw;
    if (adminPw !== ADMIN_PASSWORD) return res.status(403).json({ error: 'Unauthorized' });

    try {
      const keys = await redis('SMEMBERS', 'promos:all');
      if (!keys || !keys.length) return res.status(200).json({ codes: [] });

      const raws = await Promise.all(keys.map(k => redis('GET', `promo:${k}`)));
      const codes = raws
        .map(r => { try { return JSON.parse(r); } catch { return null; } })
        .filter(Boolean)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

      return res.status(200).json({ codes });
    } catch (err) {
      console.error('promo-codes GET error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  // POST — create a new promo code (admin only)
  if (req.method === 'POST') {
    const { adminPw, code, label } = req.body || {};
    if (adminPw !== ADMIN_PASSWORD) return res.status(403).json({ error: 'Unauthorized' });

    const cleanCode = (code || '').trim().toUpperCase();
    if (!cleanCode) return res.status(400).json({ error: 'Code is required' });
    if (!/^[A-Z0-9_-]{2,20}$/.test(cleanCode))
      return res.status(400).json({ error: 'Code must be 2–20 letters/numbers/hyphens/underscores' });

    try {
      const existing = await redis('GET', `promo:${cleanCode}`);
      if (existing) return res.status(409).json({ error: 'A code with that name already exists' });

      const promo = {
        code: cleanCode,
        label: (label || '').trim() || 'Ambassador',
        discount: 10,
        active: true,
        maxUses: 2,
        buyNowUses: 0,
        bidUses: 0,
        buyNowRevenue: 0,
        bidRevenue: 0,
        createdAt: new Date().toISOString(),
      };

      await redis('SET', `promo:${cleanCode}`, JSON.stringify(promo));
      await redis('SADD', 'promos:all', cleanCode);

      return res.status(200).json({ success: true, promo });
    } catch (err) {
      console.error('promo-codes POST error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  // DELETE — remove a promo code (admin only)
  if (req.method === 'DELETE') {
    const { adminPw, code } = req.body || {};
    if (adminPw !== ADMIN_PASSWORD) return res.status(403).json({ error: 'Unauthorized' });

    const cleanCode = (code || '').trim().toUpperCase();
    if (!cleanCode) return res.status(400).json({ error: 'Code is required' });

    try {
      await redis('DEL', `promo:${cleanCode}`);
      await redis('SREM', 'promos:all', cleanCode);
      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('promo-codes DELETE error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
