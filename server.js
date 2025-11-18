const express = require('express');
const app = express();
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

// ---------------------------
// Stripe & Supabase
// ---------------------------
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ---------------------------
// Webhook は raw で受け取る
// ---------------------------
app.post('/stripe/webhook', express.raw({ type: 'application/json' }));

// それ以外は普通に JSON
app.use(express.json());

// ---------------------------
// Stripe Webhook 本体
// ---------------------------
app.post('/stripe/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error('❌ Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log('✅ Stripe event received:', event.type);

  // ① ライセンス情報を更新するヘルパー
  async function upsertLicense({ customerId, email, status, expiresAt }) {
    const { error } = await supabase
      .from('licenses')
      .upsert(
        {
          stripe_customer_id: customerId,
          email,
          status,
          expires_at: expiresAt,
        },
        { onConflict: 'stripe_customer_id' }
      );

    if (error) {
      console.error('Supabase upsert error:', error.message);
    }
  }

  // ② イベントごとの処理
  const type = event.type;

  if (type === 'checkout.session.completed') {
    const session = event.data.object;
    const customerId = session.customer;
    const email =
      session.customer_details?.email || session.customer_email || null;

    // 初回購入：とりあえず active にしておく
    await upsertLicense({
      customerId,
      email,
      status: 'active',
      expiresAt: null, // 正確な期限は invoice.paid で更新
    });

    console.log('↪ checkout.session.completed handled');
  }

  if (type === 'invoice.paid') {
    const invoice = event.data.object;
    const customerId = invoice.customer;
    const email = invoice.customer_email || null;

    // 請求書の中から期間終了日を取り出す
    const line = invoice.lines?.data?.[0];
    const periodEndUnix = line?.period?.end; // 秒
    const expiresAt =
      periodEndUnix != null
        ? new Date(periodEndUnix * 1000).toISOString()
        : null;

    await upsertLicense({
      customerId,
      email,
      status: 'active',
      expiresAt,
    });

    console.log('↪ invoice.paid handled, expires_at =', expiresAt);
  }

  if (type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    const customerId = sub.customer;

    await upsertLicense({
      customerId,
      email: null, // 既存の email は壊さないので null
      status: 'canceled',
      expiresAt: null,
    });

    console.log('↪ customer.subscription.deleted handled');
  }

  return res.json({ received: true });
});

// ---------------------------
// EA 用 ライセンス確認API
// ---------------------------
app.post('/license/validate', async (req, res) => {
  // EA から送ってもらう情報（例）
  const { email } = req.body; // まずはメールだけでシンプルに

  if (!email) {
    return res.status(400).json({ ok: false, reason: 'email_required' });
  }

  const { data, error } = await supabase
    .from('licenses')
    .select('status, expires_at')
    .eq('email', email)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('Supabase select error:', error.message);
    return res.status(500).json({ ok: false, reason: 'server_error' });
  }

  if (!data) {
    return res.json({ ok: false, reason: 'not_found' });
  }

  const now = new Date();
  const expiresAt = data.expires_at ? new Date(data.expires_at) : null;

  let ok = false;
  let reason = '';

  if (data.status !== 'active') {
    ok = false;
    reason = data.status; // inactive / canceled
  } else if (expiresAt && expiresAt < now) {
    ok = false;
    reason = 'expired';
  } else {
    ok = true;
    reason = 'active';
  }

  return res.json({
    ok,
    reason,
    expires_at: expiresAt,
  });
});

// ---------------------------
// 動作確認用
// ---------------------------
app.get('/', (req, res) => {
  res.send('API running');
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`API running on port ${port}`);
});
