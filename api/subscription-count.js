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
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
}

module.exports = async (req, res) => {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const ADMIN_PW = process.env.ADMIN_PASSWORD || 'vb2024';

  try {
    const total = parseInt((await redis('GET', 'subscribers:total')) || '0', 10);
    const spotsLeft = Math.max(0, 200 - total);
    const isEarlyBird = total < 200;
    const currentPrice = isEarlyBird ? '9.99' : '11.99';

    // Admin gets the full subscriber list
    if ((req.query || {}).adminPw === ADMIN_PW) {
      const emails = (await redis('SMEMBERS', 'subscribers:list')) || [];
      const subscribers = (
        await Promise.all(
          emails.map(async (email) => {
            const raw = await redis('GET', `subscriber:${email}`);
            try { return JSON.parse(raw); } catch { return null; }
          })
        )
      )
        .filter(Boolean)
        .sort((a, b) => new Date(b.subscribedAt) - new Date(a.subscribedAt));

      return res.status(200).json({ total, spotsLeft, isEarlyBird, currentPrice, subscribers });
    }

    res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=120');
    return res.status(200).json({ total, spotsLeft, isEarlyBird, currentPrice });
  } catch (err) {
    console.error('subscription-count error:', err);
    return res.status(500).json({ error: err.message });
  }
};
