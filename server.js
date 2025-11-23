// ===================================================
// 基本設定
// ===================================================
const express = require('express');
const path = require('path');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const sgMail = require('@sendgrid/mail');

const app = express(); // ★これが一番最初に必要

// 静的ファイル (public フォルダ)
app.use(express.static(path.join(__dirname, "public")));


// ===================================================
// SendGrid
// ===================================================
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

async function sendEmail(to, subject, text) {
  try {
    const msg = {
      to,
      from: {
        email: process.env.SENDGRID_FROM_EMAIL,
        name: process.env.SENDGRID_FROM_NAME,
      },
      subject,
      text,
    };
    await sgMail.send(msg);
    console.log("📧 Email sent:", to);
  } catch (error) {
    console.error("❌ SendGrid Error:", error);
  }
}


// ===================================================
// Stripe & Supabase
// ===================================================
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);


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
      console.error('❌ Webhook signature error:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    console.log("⚡ Stripe Event:", event.type);

    // Supabase の upsert 関数
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

      if (error) console.error("Supabase Error:", error.message);
    }

    const type = event.type;

    // ▶ 初回購入
    if (type === 'checkout.session.completed') {
      const session = event.data.object;

      const customerId = session.customer;
      const email =
        (session.customer_details && session.customer_details.email) ||
        session.customer_email ||
        null;

      console.log("checkout.session.completed", { customerId, email });

      await upsertLicense({
        customerId,
        email,
        status: 'active',
        expiresAt: null,
      });

      // メール送信
      if (email) {
        const downloadUrl = "https://rakutore.jp/ea-download";
        const subject = "【Rakutore】EAダウンロードのご案内";
        const body = `
${email} 様

ご購入ありがとうございます！

▼EAダウンロードURL
${downloadUrl}

ご不明な点は support@rakutore.jp までお願いいたします。
Rakutore 運営`;

        await sendEmail(email, subject, body);
      }

      console.log("↪ handled: checkout.session.completed");
    }

    // ▶ 更新支払い（期限更新）
    else if (type === 'invoice.paid') {
      const invoice = event.data.object;

      const customerId = invoice.customer;
      const email = invoice.customer_email;

      const line = invoice.lines?.data?.[0];
      const expiresAt = line?.period?.end
        ? new Date(line.period.end * 1000).toISOString()
        : null;

      await upsertLicense({
        customerId,
        email,
        status: 'active',
        expiresAt,
      });

      console.log("↪ handled: invoice.paid", expiresAt);
    }

    // ▶ 解約
    else if (type === 'customer.subscription.deleted') {
      const sub = event.data.object;

      await upsertLicense({
        customerId: sub.customer,
        email: null,
        status: 'canceled',
        expiresAt: null,
      });

      console.log("↪ handled: subscription.deleted");
    }

    return res.json({ received: true });
  }
);


// ===================================================
// Webhook 以外は JSON パーサーを使う
// ===================================================
app.use(express.json());


// ===================================================
// EA ライセンス認証 API
// ===================================================
app.post('/license/validate', async (req, res) => {
  console.log("REQ BODY:", req.body);

  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ ok: false, reason: "email_required" });
  }

  const { data, error } = await supabase
    .from('licenses')
    .select('status, expires_at')
    .eq('email', email)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("Supabase read error:", error.message);
    return res.status(500).json({ ok: false, reason: "server_error" });
  }

  if (!data) {
    return res.json({ ok: false, reason: "not_found" });
  }

  const now = new Date();
  const expiresAt = data.expires_at ? new Date(data.expires_at) : null;

  let ok = false;
  let reason = "";

  if (data.status !== 'active') {
    ok = false;
    reason = data.status;
  } else if (expiresAt && expiresAt < now) {
    ok = false;
    reason = "expired";
  } else {
    ok = true;
    reason = "active";
  }

  return res.json({
    ok,
    reason,
    expires_at: expiresAt,
  });
});


// ===================================================
// 動作チェック
// ===================================================
app.get('/', (req, res) => {
  res.send("API running");
});

app.get('/healthz', (req, res) => {
  res.send("ok");
});


// ===================================================
// 起動
// ===================================================
const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
