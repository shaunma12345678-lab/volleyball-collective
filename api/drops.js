const nodemailer = require('nodemailer');
const webpush = require('web-push');
const { checkAdminAuth } = require('./_adminAuth');

async function sendPushNotifications(drop) {
  const vapidPublic = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  const vapidEmail = process.env.VAPID_EMAIL;
  if (!vapidPublic || !vapidPrivate || !vapidEmail) return;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return;

  webpush.setVapidDetails(`mailto:${vapidEmail}`, vapidPublic, vapidPrivate);

  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(['SMEMBERS', 'push-subs:all']),
  });
  const { result: keys } = await r.json();
  if (!keys || !keys.length) return;

  const payload = JSON.stringify({
    title: `New Drop — ${drop.name}`,
    body: drop.type === 'buynow'
      ? `Buy Now for $${parseFloat(drop.price || 0).toFixed(2)} — limited availability`
      : 'New auction live — place your bid now',
    url: 'https://volleyball-collective.vercel.app',
  });

  await Promise.allSettled(keys.map(async key => {
    try {
      const subR = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(['GET', `push-sub:${key}`]),
      });
      const { result: raw } = await subR.json();
      if (!raw) return;
      const sub = JSON.parse(raw);
      await webpush.sendNotification(sub, payload);
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        // Subscription expired — clean it up
        await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(['DEL', `push-sub:${key}`]),
        });
        await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(['SREM', 'push-subs:all', key]),
        });
      }
    }
  }));
}

async function sendDropNotifications(drop) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_PASS) return;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return;

  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(['SMEMBERS', 'emailsubs:all']),
  });
  const { result: emails } = await r.json();
  if (!emails || !emails.length) return;

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS },
  });

  const isMembers = drop.memberOnly ? ' · Members Only' : '';
  const typeLabel = drop.type === 'buynow' ? `Buy Now — $${parseFloat(drop.price || 0).toFixed(2)}` : 'Auction Drop';

  for (const email of emails) {
    // Fetch unsub token per subscriber so each email has a unique one-click unsubscribe link
    let unsubUrl = 'https://volleyball-collective.vercel.app/api/unsubscribe';
    try {
      const subRaw = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(['GET', `emailsub:${email}`]),
      });
      const subData = await subRaw.json();
      if (subData.result) {
        const sub = JSON.parse(subData.result);
        if (sub.unsubToken) unsubUrl += `?t=${sub.unsubToken}`;
      }
    } catch {}

    transporter.sendMail({
      from: `"Volleyball Collective" <${process.env.GMAIL_USER}>`,
      to: email,
      subject: `New Drop Just Went Live — ${drop.name}`,
      html: `
        <div style="font-family:'DM Sans',Helvetica,Arial,sans-serif;max-width:500px;margin:0 auto;background:#00154F;color:#F5F0E8;padding:36px 32px;border-radius:6px">
          <div style="font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#ED2939;margin-bottom:8px">Volleyball Collective · New Drop</div>
          <h2 style="font-size:24px;margin:0 0 16px;font-weight:700">${drop.name} is Live 🏐</h2>
          ${drop.photo ? `<img src="${drop.photo}" alt="${drop.name}" style="width:100%;max-height:280px;object-fit:cover;border-radius:4px;margin-bottom:20px">` : ''}
          <div style="display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap">
            <span style="background:rgba(237,41,57,.12);border:1px solid rgba(237,41,57,.3);color:#ED2939;padding:4px 12px;font-size:.72rem;letter-spacing:2px;text-transform:uppercase;border-radius:2px">${typeLabel}</span>
            ${drop.memberOnly ? '<span style="background:rgba(123,159,212,.1);border:1px solid rgba(123,159,212,.3);color:#7b9fd4;padding:4px 12px;font-size:.72rem;letter-spacing:2px;text-transform:uppercase;border-radius:2px">🔒 Members Only</span>' : ''}
            ${drop.size ? `<span style="background:rgba(0,35,149,.2);border:1px solid rgba(0,35,149,.4);color:#7b9fd4;padding:4px 12px;font-size:.72rem;letter-spacing:2px;text-transform:uppercase;border-radius:2px">Size ${drop.size}</span>` : ''}
          </div>
          ${drop.desc ? `<p style="margin:0 0 24px;line-height:1.6;color:#7b9fd4">${drop.desc}</p>` : ''}
          <a href="https://volleyball-collective.vercel.app" style="display:inline-block;background:#ED2939;color:#fff;padding:14px 32px;font-family:'DM Sans',sans-serif;font-size:.8rem;letter-spacing:3px;text-transform:uppercase;text-decoration:none;border-radius:2px">${drop.type === 'buynow' ? 'Buy Now →' : 'Place Your Bid →'}</a>
          <p style="margin:24px 0 0;font-size:11px;color:#7b9fd4">You're receiving this because you signed up for drop alerts. — Volleyball Collective</p>
          <p style="margin:12px 0 0;font-size:10px;color:#4a6fa0"><a href="${unsubUrl}" style="color:#4a6fa0">Unsubscribe</a> from drop alerts</p>
        </div>
      `,
    }).catch(e => console.warn(`Notification failed for ${email}:`, e.message));
  }
}

async function sendTwoHourAlerts(drops) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_PASS) return;
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return;

  const now = Date.now();
  const TWO_HOURS = 2 * 60 * 60 * 1000;
  const eligible = drops.filter(d =>
    d.status === 'published' && d.endTime &&
    (new Date(d.endTime) - now) < TWO_HOURS &&
    (new Date(d.endTime) - now) > 0
  );
  if (!eligible.length) return;

  const t = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS },
  });

  for (const drop of eligible) {
    const alreadySent = await redis('GET', `alert-2h:${drop.id}`).catch(() => null);
    if (alreadySent) continue;
    await redis('SET', `alert-2h:${drop.id}`, '1').catch(() => {});
    const secsLeft = Math.ceil((new Date(drop.endTime) - now) / 1000) + 86400;
    await redis('EXPIRE', `alert-2h:${drop.id}`, secsLeft).catch(() => {});

    const allBidIds = (await redis('SMEMBERS', 'bids:keys').catch(() => [])) || [];
    const dropBids = (await Promise.all(
      allBidIds.map(async id => {
        try { const raw = await redis('GET', `bid:${id}`); const b = JSON.parse(raw); return b.dropId === drop.id ? b : null; } catch { return null; }
      })
    )).filter(Boolean);
    if (!dropBids.length) continue;

    const byEmail = {};
    dropBids.forEach(b => {
      const key = b.email.toLowerCase().trim();
      if (!byEmail[key] || parseFloat(b.amount) > parseFloat(byEmail[key].amount)) byEmail[key] = b;
    });

    const msLeft = new Date(drop.endTime) - now;
    const h = Math.floor(msLeft / 3600000);
    const m = Math.floor((msLeft % 3600000) / 60000);
    const timeLeft = h > 0 ? `${h}h ${m}m` : `${m} minutes`;

    for (const bid of Object.values(byEmail)) {
      let unsubUrl = 'https://volleyball-collective.vercel.app/api/unsubscribe';
      try {
        const subRaw = await redis('GET', `emailsub:${bid.email.toLowerCase().trim()}`);
        if (subRaw) { const sub = JSON.parse(subRaw); if (sub.unsubToken) unsubUrl += `?t=${sub.unsubToken}`; }
      } catch {}
      t.sendMail({
        from: `"Volleyball Collective" <${process.env.GMAIL_USER}>`,
        to: bid.email,
        subject: `⏰ ${timeLeft} left — "${drop.name}" is closing soon`,
        html: `
          <div style="font-family:'DM Sans',Helvetica,Arial,sans-serif;max-width:500px;margin:0 auto;background:#00154F;color:#F5F0E8;padding:36px 32px;border-radius:6px">
            <div style="font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#ED2939;margin-bottom:8px">Volleyball Collective</div>
            <h2 style="font-size:24px;margin:0 0 16px;font-weight:700">⏰ ${timeLeft} left</h2>
            <p style="margin:0 0 12px">Hey <strong>${bid.name}</strong>,</p>
            <p style="margin:0 0 20px;line-height:1.6">The auction for <strong>${drop.name}</strong> closes in <strong style="color:#ED2939">${timeLeft}</strong>. Your current bid is <strong>$${parseFloat(bid.amount).toFixed(2)}</strong>.</p>
            <div style="background:rgba(237,41,57,.08);border-left:3px solid #ED2939;padding:14px 18px;border-radius:3px;margin-bottom:24px">
              <p style="margin:0;font-size:13px;line-height:1.6">If someone outbids you before it closes, you owe nothing. But if you want it — now is the time to rebid.</p>
            </div>
            <a href="https://volleyball-collective.vercel.app" style="display:inline-block;background:#ED2939;color:#fff;padding:14px 32px;font-family:'DM Sans',sans-serif;font-size:.8rem;letter-spacing:3px;text-transform:uppercase;text-decoration:none;border-radius:2px">Rebid Now →</a>
            <p style="margin:24px 0 0;font-size:11px;color:#7b9fd4">— Volleyball Collective</p>
            <p style="margin:12px 0 0;font-size:10px;color:#4a6fa0"><a href="${unsubUrl}" style="color:#4a6fa0">Unsubscribe</a> from drop alerts</p>
          </div>
        `,
      }).catch(e => console.warn(`2h alert failed for ${bid.email}:`, e.message));
    }
  }
}

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

function setCORS(res, method) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', method === 'GET'
    ? 'public, s-maxage=15, stale-while-revalidate=60'
    : 'no-store');
}

module.exports = async (req, res) => {
  setCORS(res, req.method);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ADMIN_PW = process.env.ADMIN_PASSWORD;

  try {
    if (req.method === 'GET') {
      const ids = (await redis('SMEMBERS', 'drops:keys')) || [];
      const allDrops = (
        await Promise.all(
          ids.map(async (id) => {
            const raw = await redis('GET', `drop:${id}`);
            try { return JSON.parse(raw); } catch { return null; }
          })
        )
      ).filter(Boolean);

      // Auto-publish teasers whose scheduled time has passed; auto-archive auctions past their end time
      const now = new Date();
      await Promise.all(allDrops.map(async drop => {
        if (drop.status === 'teaser' && drop.dropTime && new Date(drop.dropTime) <= now) {
          drop.status = 'published';
          await redis('SET', `drop:${drop.id}`, JSON.stringify(drop));
          sendDropNotifications(drop).catch(() => {});
          sendPushNotifications(drop).catch(() => {});
        } else if (drop.status === 'published' && drop.endTime && new Date(drop.endTime) <= now) {
          drop.status = 'archived';
          await redis('SET', `drop:${drop.id}`, JSON.stringify(drop));
        }
      }));

      sendTwoHourAlerts(allDrops).catch(() => {});

      const drops = allDrops.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

      // Fetch watch counts for all drops
      const watchCounts = {};
      await Promise.all(drops.map(async d => {
        const count = await redis('GET', `watch:${d.id}`);
        if (count) watchCounts[d.id] = parseInt(count);
      }));

      // Fetch notify waitlist counts for teaser drops
      const notifyCounts = {};
      await Promise.all(drops.filter(d => d.status === 'teaser').map(async d => {
        const count = await redis('SCARD', `notify:${d.id}`);
        if (count) notifyCounts[d.id] = parseInt(count);
      }));

      // Strip base64 data URLs — they bloat every response by hundreds of KB.
      // Photos should live in Vercel Blob (short URLs). If any slipped in as base64, omit them.
      const safeDrops = drops.map(d => {
        const clean = { ...d };
        if (clean.photo && clean.photo.startsWith('data:')) clean.photo = '';
        if (Array.isArray(clean.photos)) clean.photos = clean.photos.map(p => (p && p.startsWith('data:') ? '' : p)).filter(Boolean);
        return clean;
      });

      return res.status(200).json({ drops: safeDrops, watchCounts, notifyCounts });
    }

    const body = req.body || {};

    if (req.method === 'POST') {
      const authErr = await checkAdminAuth(req, body.adminPw);
      if (authErr) return res.status(authErr.status).json(authErr.json);
      if (!body.drop || !body.drop.id || !body.drop.name)
        return res.status(400).json({ error: 'drop.id and drop.name are required' });
      const existing = await redis('GET', `drop:${body.drop.id}`);
      if (existing)
        return res.status(409).json({ error: 'Drop with this id already exists' });
      await redis('SET', `drop:${body.drop.id}`, JSON.stringify(body.drop));
      await redis('SADD', 'drops:keys', body.drop.id);
      if (body.drop.status === 'published') {
        sendDropNotifications(body.drop).catch(() => {});
        sendPushNotifications(body.drop).catch(() => {});
      }
      return res.status(200).json({ success: true });
    }

    if (req.method === 'PUT') {
      const authErr = await checkAdminAuth(req, body.adminPw);
      if (authErr) return res.status(authErr.status).json(authErr.json);
      const raw = await redis('GET', `drop:${body.id}`);
      if (!raw)
        return res.status(404).json({ error: 'Drop not found' });
      const drop = JSON.parse(raw);
      if (body.action === 'setTimer') {
        if (body.endTime) drop.endTime = body.endTime;
        else delete drop.endTime;
      } else if (body.action === 'setBadges') {
        if (Array.isArray(body.badges) && body.badges.length > 0) drop.badges = body.badges;
        else delete drop.badges;
      } else if (body.action === 'setPhotos') {
        const photos = Array.isArray(body.photos) ? body.photos.filter(Boolean) : [];
        drop.photos = photos;
        drop.photo = photos[0] || drop.photo || '';
      } else {
        drop.status = drop.status === 'published' ? 'archived' : 'published';
      }
      await redis('SET', `drop:${body.id}`, JSON.stringify(drop));
      return res.status(200).json({ success: true });
    }

    if (req.method === 'DELETE') {
      const authErr = await checkAdminAuth(req, body.adminPw);
      if (authErr) return res.status(authErr.status).json(authErr.json);
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
