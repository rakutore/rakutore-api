const express = require('express');
const app = express();
const Stripe = require('stripe');

// ---------------------------
// 先に Stripe Webhook 用 raw body
// ---------------------------
app.use(
  '/stripe/webhook',
  express.raw({ type: 'application/json' })
);

// ---------------------------
// その後に JSON パーサー
// ---------------------------
app.use(express.json());

// Stripe 認証
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

// ---------------------------
// Stripe Webhook エンドポイント
// ---------------------------
app.post('/stripe/webhook', (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    // raw の req.body をそのまま使う
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error('❌ Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log('✅ Stripe event received:', event.type);

  if (event.type === 'checkout.session.completed') {
    console.log('Checkout Completed!');
  }

  if (event.type === 'invoice.paid') {
    console.log('Invoice Paid!');
  }

  if (event.type === 'customer.subscription.deleted') {
    console.log('Subscription Deleted!');
  }

  return res.json({ received: true });
});

// ---------------------------
// テスト用
// ---------------------------
app.get('/', (req, res) => {
  res.send('API running');
});

// ---------------------------
// ポート
// ---------------------------
const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`API running on port ${port}`);
});
