// ===================================================
// Stripe Webhook（raw 必須）
// ===================================================
app.post(
  '/stripe/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    let event;
    const sig = req.headers['stripe-signature'];

    try {
      event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
      console.error('Webhook signature error:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Webhook 処理...
    return res.json({ received: true });
  }
);

// ===================================================
// Stripe 以外のルートはここから JSON パーサーが有効
// ===================================================
app.use(express.json());

// ===================================================
// EA ライセンス認証 API
// ===================================================
app.post('/license/validate', async (req, res) => {
  console.log("REQ BODY:", req.body);

  const { email } = req.body;
  if (!email) return res.status(400).json({ ok: false, reason: "email_required" });

  // Supabase処理...
});
