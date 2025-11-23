// ===================================================
// 基本設定
// ===================================================
const express = require('express');
const path = require('path');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const sgMail = require('@sendgrid/mail');

const app = express();

// 静的ファイル
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
// EA ライセンス認証 API（MT4対応 / 1メール1口座縛り）
// ===================================================
app.post(
  '/license/validate',
  express.urlencoded({ extended: false }), // form
  express.text({ type: '*/*' }),           // text fallback
  async (req, res) => {

    console.log("REQ BODY:", req.body);

    let email = req.body?.email;
    let account = req.body?.account;

    // MT4の生文字列も拾う
    if (typeof req.body === "string") {
      const m1 = req.body.match(/email=([^&\s]+)/);
      const m2 = req.body.match(/account=([^&\s]+)/);
      if (m1) email = decodeURIComponent(m1[1]);
      if (m2) account = decodeURIComponent(m2[1]);
    }

    if (!email) {
      return res.status(400).json({ ok: false, reason: "email_required" });
    }
    if (!account) {
      return res.status(400).json({ ok: false, reason: "account_required" });
    }

    account = Number(account);

    const { data, error } = await supabase
      .from('licenses')
      .select('id, status, expires_at, bound_account')
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

    // ステータスチェック
    if (data.status !== "active") {
      return res.json({ ok: false, reason: data.status });
    }
    if (expiresAt && expiresAt < now) {
      return res.json({ ok: false, reason: "expired" });
    }

    // 初回バインド
    if (!data.bound_account) {
      const { error: upErr } = await supabase
        .from("licenses")
        .update({
          bound_account: account,
          bound_at: now.toISOString(),
          last_check_at: now.toISOString(),
        })
        .eq("id", data.id);

      if (upErr) {
        console.error("Supabase update error:", upErr.message);
        return res.status(500).json({ ok: false, reason: "server_error" });
      }

      return res.json({
        ok: true,
        reason: "active_bound",
        bound_account: account,
        expires_at: expiresAt
      });
    }

    // 別口座 → NG
    if (Number(data.bound_account) !== account) {
      return res.json({
        ok: false,
        reason: "account_mismatch",
        bound_account: data.bound_account
      });
    }

    // 同じ口座 → OK
    await supabase
      .from("licenses")
      .update({ last_check_at: now.toISOString() })
      .eq("id", data.id);

    return res.json({
      ok: true,
      reason: "active",
      bound_account: data.bound_account,
      expires_at: expiresAt
    });
  }
);


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
