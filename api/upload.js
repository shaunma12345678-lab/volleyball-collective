const { put } = require('@vercel/blob');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

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

  const { dataUrl, adminPw } = req.body || {};
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: 'Admin not configured' });
  if (adminPw !== ADMIN_PASSWORD) return res.status(403).json({ error: 'Unauthorized' });
  if (!dataUrl || !dataUrl.startsWith('data:image/')) return res.status(400).json({ error: 'Invalid image data' });

  const base64 = dataUrl.split(',')[1];
  if (!base64) return res.status(400).json({ error: 'Could not parse image data' });

  try {
    // Try Vercel Blob first (fast CDN delivery)
    const blobToken = process.env.BLOB2_READ_WRITE_TOKEN || process.env.BLOB1_READ_WRITE_TOKEN || process.env.BLOB_READ_WRITE_TOKEN;
    if (blobToken) {
      try {
        const buffer = Buffer.from(base64, 'base64');
        const filename = `drops/photo-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
        const blob = await put(filename, buffer, { access: 'public', contentType: 'image/jpeg', token: blobToken });
        return res.status(200).json({ url: blob.url });
      } catch (blobErr) {
        console.warn('Blob upload failed, falling back to Redis proxy:', blobErr.message);
      }
    }

    // Fallback: store compressed image in Redis, serve via /api/photo
    const photoId = `photo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await redis('SET', `photo:${photoId}`, dataUrl, 'EX', String(60 * 60 * 24 * 365));
    const origin = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : 'https://volleyball-collective.vercel.app';
    return res.status(200).json({ url: `${origin}/api/photo?id=${photoId}` });
  } catch (err) {
    console.error('upload error:', err);
    return res.status(500).json({ error: err.message });
  }
};
