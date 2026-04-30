// Shared admin authentication with IP-based rate limiting.
// Underscore prefix → Vercel does not expose this as a route.

const MAX_ATTEMPTS = 8;       // failed attempts before lockout
const WINDOW_SECONDS = 900;   // 15-minute window
const LOCKOUT_SECONDS = 1800; // 30-minute lockout after MAX_ATTEMPTS

async function redisCall(args) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const data = await res.json();
    return data.result;
  } catch { return null; }
}

function getIP(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

// Call this at the start of every admin-protected handler.
// Returns null if OK to proceed, or a Response-like {status, json} if the request should be rejected.
async function checkAdminAuth(req, suppliedPassword) {
  const ADMIN_PW = process.env.ADMIN_PASSWORD;
  if (!ADMIN_PW) {
    // No password configured — block everything
    return { status: 503, json: { error: 'Admin not configured' } };
  }

  const ip = getIP(req);
  const lockKey = `admin:lock:${ip}`;
  const failKey = `admin:fail:${ip}`;

  // Check if this IP is locked out
  const locked = await redisCall(['GET', lockKey]);
  if (locked) {
    return { status: 429, json: { error: 'Too many failed attempts. Try again in 30 minutes.' } };
  }

  if (suppliedPassword !== ADMIN_PW) {
    // Wrong password — increment failure counter
    const fails = await redisCall(['INCR', failKey]);
    await redisCall(['EXPIRE', failKey, WINDOW_SECONDS]);

    if (fails >= MAX_ATTEMPTS) {
      // Lock this IP out
      await redisCall(['SET', lockKey, '1', 'EX', LOCKOUT_SECONDS]);
      await redisCall(['DEL', failKey]);
      return { status: 429, json: { error: 'Too many failed attempts. Try again in 30 minutes.' } };
    }

    return { status: 403, json: { error: 'Unauthorized' } };
  }

  // Correct password — clear any failure count
  await redisCall(['DEL', failKey]);
  return null;
}

module.exports = { checkAdminAuth };
