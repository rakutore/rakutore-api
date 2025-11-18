const express = require('express');
const app = express();
const Stripe = require('stripe');

// ⭐ Webhook は JSON パースより前に raw() を適用
app.use(
  '/stripe/webhook',
  express.raw({ type: 'application/json' })
);

// ⭐ 通常 API 用
app.use(express.json());

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

app.post('/stripe/webhook', (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log('Stripe event:', event.type);

  return res.json({ received: true });
});

app.get('/', (req, res) => {
  res.send('API OK');
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log('API running on port', PORT);
});
