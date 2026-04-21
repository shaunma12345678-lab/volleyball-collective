
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const nodemailer = require('nodemailer');

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

async function sendWelcomeEmail(subscriber) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_PASS) return;
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS },
  });
  const isEarlyBird = subscriber.plan === '9.99';
  await transporter.sendMail({
    from: `"Volleyball Collective" <${process.env.GMAIL_USER}>`,
    to: subscriber.email,
    subject: `Welcome to Volleyball Collective — You're a Founding Member!`,
    html: `
      <div style="font-family:'DM Sans',Helvetica,Arial,sans-serif;max-width:500px;margin:0 auto;background:#00154F;color:#F5F0E8;padding:36px 32px;border-radius:6px">
        <div style="font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#ED2939;margin-bottom:8px">Volleyball Collective</div>
        <h2 style="font-size:24px;margin:0 0 20px;font-weight:700">Welcome, ${subscriber.name}!</h2>
        <p style="margin:0 0 20px;line-height:1.6">
          You're officially ${isEarlyBird ? 'a <strong>Founding Member</strong>' : 'a <strong>Member</strong>'} of Volleyball Collective.
          Your subscription of <strong style="color:#3ecf8e">$${subscriber.plan}/month</strong> is now active.
        </p>
        <div style="background:rgba(62,207,142,.08);border-left:3px solid #3ecf8e;padding:14px 18px;border-radius:3px;margin-bottom:20px">
          <p style="margin:0;font-size:13px;line-height:2">
            Early drop access — 24 hours before public<br>
            Priority bidding on every auction<br>
            Members-only shop items<br>
            Direct alerts on every new drop
          </p>
        </div>
        <p style="margin:0;font-size:11px;color:#7b9fd4">Thank you for being part of the collective. — Volleyball Collective</p>
      </div>
    `,
  });
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error('STRIPE_WEBHOOK_SECRET not configured');
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }

  let event;
  try {
    const rawBody = await new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      if (session.mode !== 'subscription' || session.payment_status !== 'paid') {
        return res.status(200).json({ received: true });
      }

      const email = (session.metadata?.email || session.customer_email || '').toLowerCase().trim();
      const name = session.metadata?.name || email;
      const plan = session.metadata?.plan || '11.99';

      if (!email) return res.status(200).json({ received: true });

      const existing = await redis('GET', `subscriber:${email}`);
      const wasAlreadyActive = existing ? JSON.parse(existing).status === 'active' : false;

      const subscriber = {
        email, name, status: 'active', plan,
        stripeCustomerId: session.customer,
        stripeSubscriptionId: session.subscription,
        subscribedAt: new Date().toISOString(),
      };

      await redis('SET', `subscriber:${email}`, JSON.stringify(subscriber));
      await redis('SADD', 'subscribers:list', email);
      if (!wasAlreadyActive) await redis('INCR', 'subscribers:total');

      try { await sendWelcomeEmail(subscriber); } catch (e) { console.warn('Welcome email failed:', e.message); }
    }

    if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      const emails = (await redis('SMEMBERS', 'subscribers:list')) || [];
      await Promise.all(emails.map(async (email) => {
        const raw = await redis('GET', `subscriber:${email}`);
        if (!raw) return;
        const sub = JSON.parse(raw);
        if (sub.stripeSubscriptionId === subscription.id) {
          sub.status = 'cancelled';
          sub.cancelledAt = new Date().toISOString();
          await redis('SET', `subscriber:${email}`, JSON.stringify(sub));
        }
      }));
    }

    if (event.type === 'invoice.payment_failed') {
      console.warn('Payment failed for customer:', event.data.object.customer);
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err);
    return res.status(200).json({ received: true, warning: err.message });
  }
}

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
