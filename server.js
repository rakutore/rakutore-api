const express = require('express');
const Stripe = require('stripe');
const bodyParser = require('body-parser');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();

// Stripe Webhook は raw body 必須
app.post('/stripe/webhook',
  bodyParser.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

    try {
      const event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);

      console.log("Stripe webhook received:", event.type);

      res.json({ received: true });
    } catch (err) {
      console.error("Webhook Error:", err.message);
      res.status(400).send(`Webhook Error: ${err.message}`);
    }
  }
);

app.get('/', (req, res) => {
  res.send('API running');
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`API running on port ${port}`));
