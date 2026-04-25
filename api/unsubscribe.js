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

function page(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — Volleyball Collective</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#00154F;color:#F5F0E8;font-family:'DM Sans',Helvetica,Arial,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .card{max-width:480px;width:100%;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:40px 36px;text-align:center}
  .label{font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#ED2939;margin-bottom:16px}
  h1{font-size:22px;font-weight:700;margin-bottom:16px}
  p{font-size:14px;line-height:1.6;color:#7b9fd4;margin-bottom:24px}
  a{display:inline-block;background:#ED2939;color:#fff;padding:12px 28px;font-size:.75rem;letter-spacing:3px;text-transform:uppercase;text-decoration:none;border-radius:2px}
</style>
</head>
<body>
<div class="card">
  <div class="label">Volleyball Collective</div>
  ${body}
  <a href="https://volleyball-collective.vercel.app">Back to the Drops</a>
</div>
</body>
</html>`;
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    return res.status(405).send(page('Error', '<h1>Method not allowed</h1><p>This link only supports GET requests.</p>'));
  }

  const token = (req.query || {}).t;
  if (!token) {
    return res.status(400).send(page('Invalid Link', '<h1>Invalid Link</h1><p>This unsubscribe link appears to be invalid or missing a token.</p>'));
  }

  try {
    const email = await redis('GET', `unsub:${token}`);
    if (!email) {
      return res.status(200).send(page('Already Removed', `<h1>Already Unsubscribed</h1><p>You've already been removed from our email list, or this link has expired. You won't receive any further emails from us.</p>`));
    }

    await Promise.all([
      redis('DEL', `emailsub:${email}`),
      redis('SREM', 'emailsubs:all', email),
      redis('DEL', `unsub:${token}`),
    ]);

    return res.status(200).send(page('Unsubscribed', `<h1>You're Off the List</h1><p><strong>${email}</strong> has been removed from our email list. You won't receive any more drop alerts or emails from Volleyball Collective.</p>`));
  } catch (err) {
    console.error('unsubscribe error:', err);
    return res.status(500).send(page('Error', '<h1>Something went wrong</h1><p>We ran into an error processing your request. Please try again or contact us directly.</p>'));
  }
};
