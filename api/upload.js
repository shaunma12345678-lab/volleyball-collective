const { put } = require('@vercel/blob');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'vb2024';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { dataUrl, adminPw } = req.body || {};
  if (adminPw !== ADMIN_PASSWORD) return res.status(403).json({ error: 'Unauthorized' });
  if (!dataUrl || !dataUrl.startsWith('data:image/')) return res.status(400).json({ error: 'Invalid image data' });

  try {
    const base64 = dataUrl.split(',')[1];
    if (!base64) return res.status(400).json({ error: 'Could not parse image data' });

    const buffer = Buffer.from(base64, 'base64');
    const filename = `drops/photo-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;

    const blob = await put(filename, buffer, {
      access: 'public',
      contentType: 'image/jpeg',
    });

    return res.status(200).json({ url: blob.url });
  } catch (err) {
    console.error('upload error:', err);
    return res.status(500).json({ error: err.message });
  }
};
