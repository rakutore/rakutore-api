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
// Stripe / Supabase
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

    // ===================================================
    // 共通アップサート関数
    // ===================================================
    async function upsertLicense({ customerId, email, status, expiresAt, planType }) {
      const { error } = await supabase
        .from('licenses')
        .upsert(
          {
            stripe_customer_id: customerId,
            email,
            status,
            expires_at: expiresAt,
            plan_type: planType,        // ★追加
          },
          { onConflict: 'stripe_customer_id' }
        );

      if (error) console.error("Supabase Error:", error.message);
    }

    const type = event.type;

    // ===================================================
    // 🔵 1) checkout.session.completed （申込完了）
    // ===================================================
    if (type === 'checkout.session.completed') {
      const s = event.data.object;

      const customerId = s.customer;
      const email =
        (s.customer_details && s.customer_details.email) ||
        s.customer_email ||
        null;

      // ★ checkout 時点はまだ課金されていない → trial 扱い
      await upsertLicense({
        customerId,
        email,
        status: 'active',
        expiresAt: null,
        planType: 'trial',
      });

      // ダウンロードメール
      if (email) {
        const downloadUrl = "https://rakutore.jp/ea-download";
        const subject = "【Rakutore】EAダウンロードのご案内";
        const body = `
${email} 様

ご購入ありがとうございます。

▼EAダウンロードURL
${downloadUrl}

ご不明点は support@rakutore.jp までご連絡ください。
Rakutore運営
        `;

        await sendEmail(email, subject, body);
      }

      console.log("↪ handled: checkout.session.completed");
    }

    // ===================================================
    // 🔵 2) invoice.paid （課金成功 → 本会員）
    // ===================================================
    else if (type === 'invoice.paid') {
      const invoice = event.data.object;

      const customerId = invoice.customer;
      const email = invoice.customer_email;

      const line = invoice.lines?.data?.[0];
      const priceId = line?.price?.id;
      const expiresAt = line?.period?.end
        ? new Date(line.period.end * 1000).toISOString()
        : null;

      // ★ 即時スタートプランの価格ID
      const instantPriceId = "price_1SXKrLFWKU6pTKTIQmNXmesu";

      // ★ 特別判定：即時スタートは最初から paid
      const isInstantPlan = priceId === instantPriceId;

      await upsertLicense({
        customerId,
        email,
        status: 'active',
        expiresAt,
        planType: isInstantPlan ? 'paid' : 'paid',
      });

      console.log("↪ handled: invoice.paid");
    }

    // ===================================================
    // 🔵 3) customer.subscription.deleted （解約）
    // ===================================================
    else if (type === 'customer.subscription.deleted') {
      const sub = event.data.object;

      await upsertLicense({
        customerId: sub.customer,
        email: null,
        status: 'canceled',
        expiresAt: null,
        planType: 'canceled',
      });

      console.log("↪ handled: subscription.deleted");
    }

    return res.json({ received: true });
  }
);


// ===================================================
// Webhook 以外の JSON パース
// ===================================================
app.use(express.urlencoded({ extended: false }));
app.use(express.text({ type: 'text/*' }));
app.use(express.json());


// ===================================================
// EA ライセンス認証 API
// ===================================================
app.post('/license/validate', async (req, res) => {
  try {
    console.log("REQ RAW BODY:", req.body);

    let email;
    let account;
    let server;

    // ----------------------------
    // MT4 の NULL 除去
    // ----------------------------
    const raw = typeof req.body === 'string'
      ? req.body.replace(/\x00/g, '')
      : '';

    const formEmail = req.body?.email?.replace?.(/\x00/g, '');
    const formAccount = req.body?.account?.replace?.(/\x00/g, '');
    const formServer = req.body?.server?.replace?.(/\x00/g, '');

    email = formEmail || null;
    account = formAccount || null;
    server = formServer || null;

    // 生文字列 fallback
    if (!email) {
      const m = raw.match(/email=([^&]+)/);
      if (m) email = decodeURIComponent(m[1]);
    }
    if (!account) {
      const n = raw.match(/account=([^&]+)/);
      if (n) account = decodeURIComponent(n[1]);
    }
    if (!server) {
      const s = raw.match(/server=([^&]+)/);
      if (s) server = decodeURIComponent(s[1]);
    }

    if (!email) return res.json({ ok: false, reason: "email_required" });
    if (!account) return res.json({ ok: false, reason: "account_required" });
    if (!server) return res.json({ ok: false, reason: "server_required" });

    account = Number(String(account).replace(/\D/g, ''));
    const serverName = server.toLowerCase();

    // ----------------------------
    // Supabase 読み取り
    // ----------------------------
    const { data, error } = await supabase
      .from("licenses")
      .select("id, status, expires_at, bound_account, plan_type")
      .eq("email", email)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error("Supabase read error:", error.message);
      return res.json({ ok: false, reason: "server_error" });
    }

    if (!data) {
      return res.json({ ok: false, reason: "not_found" });
    }

    const now = new Date();
    const expiresAt = data.expires_at ? new Date(data.expires_at) : null;

    if (data.status !== "active") {
      return res.json({ ok: false, reason: data.status });
    }

    if (expiresAt && expiresAt < now) {
      return res.json({ ok: false, reason: "expired" });
    }

    // ===================================================
    // 🟡 トライアルプラン → デモのみ許可
    // ===================================================
    if (data.plan_type === "trial") {
      if (!serverName.includes("demo")) {
        return res.json({
          ok: false,
          reason: "trial_demo_only"
        });
      }
    }

    // ----------------------------
    // 初回バインド
    // ----------------------------
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
        return res.json({ ok: false, reason: "server_error" });
      }

      return res.json({
        ok: true,
        reason: "active_bound",
        bound_account: account,
        expires_at: expiresAt,
      });
    }

    // ----------------------------
    // 別口座 → NG
    // ----------------------------
    if (Number(data.bound_account) !== account) {
      return res.json({
        ok: false,
        reason: "account_mismatch",
        bound_account: data.bound_account
      });
    }

    // ----------------------------
    // 同じ口座 → OK
    // ----------------------------
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

  } catch (err) {
    console.error("❌ Unexpected Server Error:", err);
    return res.json({ ok: false, reason: "server_error" });
  }
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
