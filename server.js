import express from 'express';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import bodyParser from 'body-parser';

const app = express();

// Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Raw body needed for Stripe signature verification
app.use(
  bodyParser.raw({ type: 'application/json' })
);

app.post('/stripe/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('❌ Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log('🔔 Received event:', event.type);

  try {
    switch (event.type) {

      /* -----------------------------------------
       *  Checkout 完了 → ライセンス作成
       * ----------------------------------------- */
      case 'checkout.session.completed': {
        const session = event.data.object;

        const customerId = session.customer;
        const email = session.customer_details?.email || null;

        console.log('🟢 checkout.session.completed', {
          customerId,
          email,
        });

        const { error } = await supabase
          .from('licenses')
          .insert({
            stripe_customer_id: customerId,
            email: email,
            status: 'active',
            expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
          });

        if (error) console.error('❌ Supabase insert error:', error);
        break;
      }

      /* -----------------------------------------
       *  請求書支払い → 有効期限を延長
       * ----------------------------------------- */
      case 'invoice.paid': {
        const invoice = event.data.object;
        const customerId = invoice.customer;

        console.log('🟢 invoice.paid', { customerId });

        const { error } = await supabase
          .from('licenses')
          .update({
            status: 'active',
            expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
          })
          .eq('stripe_customer_id', customerId);

        if (error) console.error('❌ Supabase update error:', error);
        break;
      }

      /* -----------------------------------------
       *  サブスク解約 → ライセンス停止
       * ----------------------------------------- */
      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const customerId = subscription.customer;

        console.log('🟠 subscription deleted', { customerId });

        const { error } = await supabase
          .from('licenses')
          .update({
            status: 'canceled',
            expires_at: null
          })
          .eq('stripe_customer_id', customerId);

        if (error) console.error('❌ Supabase update error:', error);
        break;
      }

      default:
        console.log(`ℹ️ Event not handled: ${event.type}`);
    }

    return res.json({ received: true });

  } catch (err) {
    console.error('❌ Webhook handling error:', err);
    return res.status(500).send('Server error');
  }
});

// Server 起動
app.listen(8080, () => console.log('API running on port 8080'));
