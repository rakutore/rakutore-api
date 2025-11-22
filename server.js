// ===================================================
// 基本設定
// ===================================================
const express = require('express');
const path = require('path');   // ← これ追加
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const sgMail = require('@sendgrid/mail');

const app = express();

// ✅ publicフォルダを静的配信（絶対パス）
app.use(express.static(path.join(__dirname, "public")));


// ===================================================
// SendGrid
// ===================================================
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// 汎用メール関数
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

    // -----------------------------
    // Supabase にライセンスを保存
    // -----------------------------
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

  // -----------------------------
// 個別の Stripe イベント処理
// -----------------------------
const type = event.type;

// ▶ 購入完了（初回）
if (type === 'checkout.session.completed') {
  const session = event.data.object;
  const customerId = session.customer;

  const email =
    (session.customer_details && session.customer_details.email) ||
    session.customer_email ||
    null;

  console.log("checkout.session.completed", { customerId, email });

  // 初回は active のまま作成
  await upsertLicense({
    customerId,
    email,
    status: 'active',
    expiresAt: null,
  });

  // ★ EA ダウンロード案内メール送信
  if (email) {
    const downloadUrl = "https://rakutore.jp/ea-download"; // ← 実際のDLページのURLにあとで差し替え

    const subject = "【Rakutore】EAダウンロードのご案内";

    const body = `
${email} 様

このたびは「Rakutore EA」をご購入いただきありがとうございます。

下記のURLからEAファイルをダウンロードしてご利用ください。

▼EAダウンロードURL
${downloadUrl}

────────────────────────
■ ライセンスについて
────────────────────────
・このEAは「${email}」のメールアドレスに対して発行されたライセンスでのみ有効です。
・MT4にセットする際は、口座番号や環境がライセンス条件を満たしていることをご確認ください。
・ライセンス条件に合わない環境では、EAが動作しない・もしくは停止する場合があります。

────────────────────────
■ ご利用上の注意
────────────────────────
・本EAの再配布、転売、共有などはご遠慮ください。
・ご利用は自己責任となります。相場状況によっては損失が発生する可能性があります。
・必ずデモ口座などで動作確認を行った上で、本番運用を開始してください。

────────────────────────
■ お問い合わせ
────────────────────────
ご不明な点がございましたら、以下のメールアドレスまでご連絡ください。

support@rakutore.jp

今後とも、どうぞよろしくお願いいたします。

Rakutore 運営
`;

    await sendEmail(email, subject, body);
    console.log("📧 EA ダウンロード案内メールを送信しました:", email);
  }

  console.log("↪ handled: checkout.session.completed");
}

    // ▶ 支払い成功（更新された期限を保存）
    else if (type === 'invoice.paid') {
      const invoice = event.data.object;
      const customerId = invoice.customer;
      const email = invoice.customer_email || null;

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
      const customerId = sub.customer;

      await upsertLicense({
        customerId,
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
// Webhook 以外の API は JSON 解析
// ===================================================
app.use(express.json());

// ===================================================
// EA ライセンス認証 API
// ===================================================
app.post('/license/validate', async (req, res) => {
  const { email } = req.body;

  if (!email) return res.status(400).json({ ok: false, reason: "email_required" });

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

  if (!data) return res.json({ ok: false, reason: "not_found" });

  const now = new Date();
  const expiresAt = data.expires_at ? new Date(data.expires_at) : null;
  let ok = false;
  let reason = "";

  if (data.status !== 'active') {
    ok = false;
    reason = data.status;
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

// GET は説明用
app.get('/license/validate', (req, res) => {
  res.send("POST 専用 API です");
});

// ===================================================
// 動作チェック
// ===================================================
app.get('/', (req, res) => {
  res.send("API running");
});
// ★★★ ここから追加 ↓↓↓

// SendGrid テスト送信用エンドポイント
app.get('/debug/send-test', async (req, res) => {
  try {
await sendEmail(
  "happytomo365@gmail.com",  // ← 半角の @ を使う！！
  "【テスト】Rakutore SendGrid メール",
  "このメールが届いていれば成功です 🎉"
);
    res.send('テストメール送信しました！（ログと受信ボックスを確認してね）');
  } catch (e) {
    console.error(e);
    res.status(500).send('送信エラー');
  }
});

// ★★★ 追加ここまで ↑↑↑
// ===================================================
// 起動
// ===================================================
const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
