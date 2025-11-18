// Express 読み込み（CommonJS）
const express = require('express');
const app = express();
const Stripe = require('stripe');

// JSON 読み込み
app.use(express.json());

// Webhook の Raw body 用
app.use(
  '/stripe/webhook',
  express.raw({ type: 'application/json' })
);

// 環境変数
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

// ---------------------------
// Stripe Webhook 受信
// ---------------------------
app.post('/stripe/webhook', (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log('Stripe event received:', event.type);

  // ---- イベント別処理 ----
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
  res.send('API OK');
});

// ---------------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log('API running on port', PORT);
});
