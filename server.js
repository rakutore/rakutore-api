// ===================================================
// 基本設定
// ===================================================
const express = require('express');
const path = require('path');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const sgMail = require('@sendgrid/mail');
const crypto = require('crypto');

const app = express();

// 静的ファイル
app.use(express.static(path.join(__dirname, 'public')));

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
    console.log('📧 Email sent:', to);
  } catch (error) {
    console.error('❌ SendGrid Error:', error);
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
// ダウンロード用トークン発行（1回だけ有効）
// ===================================================
async function issueDownloadToken(email) {
  try {
    // ランダムな 32文字のトークン
    const token = crypto.randomBytes(16).toString('hex');

    const { error } = await supabase
      .from('download_tokens')
      .insert({ email, token });

    if (error) {
      console.error('❌ issueDownloadToken error:', error.message);
      return null;
    }

    return token;
  } catch (err) {
    console.error('❌ issueDownloadToken fatal error:', err);
    return null;
  }
}

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

    console.log('⚡ Stripe Event:', event.type);

    async function upsertLicense({
      customerId,
      email,
      status,
      expiresAt,
      planType,
    }) {
      const { error } = await supabase
        .from('licenses')
        .upsert(
          {
            stripe_customer_id: customerId,
            email,
            status,
            expires_at: expiresAt,
            plan_type: planType,
          },
          { onConflict: 'stripe_customer_id' }
        );

      if (error) console.error('Supabase Error:', error.message);
    }

    const type = event.type;

    // ================================
    // 1) checkout.session.completed
    // ================================
    if (type === 'checkout.session.completed') {
      const s = event.data.object;
      const customerId = s.customer;
      const email =
        (s.customer_details && s.customer_details.email) ||
        s.customer_email ||
        null;

      // --- 価格ID取得 ---
      const priceId =
        s?.display_items?.[0]?.price?.id ||
        s?.line_items?.data?.[0]?.price?.id ||
        null;

      // --- プラン判定 ---
      let planType = 'paid';
      if (priceId === 'price_1SXAQUFWKU6pTKTIyPRFtc3Q') {
        planType = 'trial';
      }

      await upsertLicense({
        customerId,
        email,
        status: 'active',
        expiresAt: null,
        planType,
      });

      console.log('↪ handled: checkout.session.completed');

      // ★ ここから：ダウンロードトークン発行＆メール送信
      if (email) {
        const token = await issueDownloadToken(email);

        if (token) {
          const downloadUrl = `https://api.rakutore.jp/download?token=${token}`;

          await sendEmail(
            email,
            '【Rakutore Anchor】EAダウンロードのご案内',
            `ご購入ありがとうございます。

以下のURLからEAをダウンロードできます。（1回のみ有効）

${downloadUrl}

※ 一度アクセスすると無効になります。
※ 再ダウンロードが必要な場合は support@rakutore.jp までご連絡ください。

Rakutore Anchor 運営`
          );

          console.log('📩 ダウンロードURL送信:', downloadUrl);
        }
      }
    }

    // ================================
    // 2) invoice.paid
    // ================================
    else if (type === 'invoice.paid') {
      const invoice = event.data.object;
      const customerId = invoice.customer;
      const email = invoice.customer_email;

      const line = invoice.lines.data[0];
      const expiresAt = line?.period?.end
        ? new Date(line.period.end * 1000).toISOString()
        : null;

      const priceId = line.price.id;

      const planType =
        priceId === 'price_1SXAQUFWKU6pTKTIyPRFtc3Q' ? 'trial' : 'paid';

      await upsertLicense({
        customerId,
        email,
        status: 'active',
        expiresAt,
        planType,
      });

      console.log('↪ handled: invoice.paid');
    }

    // ================================
    // 3) subscription.deleted
    // ================================
    else if (type === 'customer.subscription.deleted') {
      const sub = event.data.object;

      await upsertLicense({
        customerId: sub.customer,
        email: null,
        status: 'canceled',
        expiresAt: null,
        planType: 'canceled',
      });

      console.log('↪ handled: subscription.deleted');
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
// EAダウンロード確認画面（GET）
// ===================================================
app.get('/download', async (req, res) => {
  try {
    const token = req.query.token;

    if (!token) {
      return res.status(400).send('Invalid or expired token');
    }

    // トークンを検索
    const { data, error } = await supabase
      .from('download_tokens')
      .select('*')
      .eq('token', token)
      .maybeSingle();

    if (error) {
      console.error('❌ download_tokens select error:', error.message);
      return res.status(500).send('Server error');
    }

    if (!data) {
      return res.status(400).send('Invalid or expired token');
    }

    if (data.used_at) {
      return res.status(410).send('This link has already been used.');
    }

    // 確認画面を表示
    res.send(`
      <html>
        <head>
          <meta charset="utf-8" />
          <title>Rakutore Anchor ダウンロード</title>
        </head>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 40px auto;">
          <h2>Rakutore Anchor ダウンロード</h2>
          <p>以下のボタンを押すとダウンロードが開始されます。</p>
          <p>このリンクは <strong>1回のみ</strong> 有効です。</p>

          <form method="POST" action="/download">
            <input type="hidden" name="token" value="${token}" />
            <button type="submit"
              style="padding: 10px 20px; font-size: 16px; background:#5c4c9b; color:#fff; border:none; border-radius:6px; cursor:pointer;">
              ダウンロードする
            </button>
          </form>
        </body>
      </html>
    `);
  } catch (err) {
    console.error('❌ /download (GET) unexpected error:', err);
    return res.status(500).send('Server error');
  }
});

// ===================================================
// EAダウンロード処理（POST）
// ===================================================
app.post('/download', async (req, res) => {
  try {
    const token = req.body.token;

  if (!data) {
  return res
    .status(404)
    .send('Invalid or expired token.   無効または期限切れのURLです');
}


    // トークンを検索
    const { data, error } = await supabase
      .from('download_tokens')
      .select('*')
      .eq('token', token)
      .maybeSingle();

    if (error) {
      console.error('❌ download_tokens select error:', error.message);
      return res.status(500).send('Server error');
    }

    if (!data) {
      return res.status(400).send('Invalid or expired token');
    }

 return res
  .status(410)
  .set('Content-Type', 'text/html; charset=utf-8')
  .send('This link has already been used.<br>（このURLはすでに使用されています）');


    // Supabase Storage から署名付きURLを発行（有効 60 秒）
    const filePath = 'Rakutore_Anchor_v3.zip'; // ← Buckets「ea-secure」にある実際のファイル名
    const { data: signed, error: signedError } = await supabase.storage
      .from('ea-secure')
      .createSignedUrl(filePath, 60);

    if (signedError || !signed) {
      console.error('❌ createSignedUrl error:', signedError?.message);
      return res.status(500).send('Failed to generate download URL.');
    }

    // トークンを使用済みにする
    const now = new Date().toISOString();
    const { error: updateError } = await supabase
      .from('download_tokens')
      .update({ used_at: now })
      .eq('id', data.id);

    if (updateError) {
      console.error('❌ download_tokens update error:', updateError.message);
      // ここで return しない：リンク自体は有効にする
    }

    // 署名付きURLへリダイレクト → ZIP ダウンロード開始
    return res.redirect(signed.signedUrl);
  } catch (err) {
    console.error('❌ /download (POST) unexpected error:', err);
    return res.status(500).send('Server error');
  }
});

// ===================================================
// EA ライセンス認証 API
// ===================================================
app.post('/license/validate', async (req, res) => {
  try {
    let email;
    let account;
    let server;

    const raw =
      typeof req.body === 'string' ? req.body.replace(/\x00/g, '') : '';

    const formEmail = req.body?.email?.replace?.(/\x00/g, '');
    const formAccount = req.body?.account?.replace?.(/\x00/g, '');
    const formServer = req.body?.server?.replace?.(/\x00/g, '');

    email = formEmail || null;
    account = formAccount || null;
    server = formServer || null;

    if (!email) return res.json({ ok: false, reason: 'email_required' });
    if (!account) return res.json({ ok: false, reason: 'account_required' });
    if (!server) return res.json({ ok: false, reason: 'server_required' });

    account = Number(String(account).replace(/\D/g, ''));

    const { data, error } = await supabase
      .from('licenses')
      .select('id, status, expires_at, bound_account, plan_type')
      .eq('email', email)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!data) return res.json({ ok: false, reason: 'not_found' });

    const now = new Date();
    const expiresAt = data.expires_at ? new Date(data.expires_at) : null;

    if (data.status !== 'active')
      return res.json({ ok: false, reason: data.status });

    if (expiresAt && expiresAt < now)
      return res.json({ ok: false, reason: 'expired' });

    // トライアル → デモのみ
    if (data.plan_type === 'trial') {
      const s =
        (req.body.server ||
          raw.match(/server=([^&]+)/)?.[1] ||
          ''
        ).toLowerCase();

      if (!s.includes('demo')) {
        return res.json({ ok: false, reason: 'trial_demo_only' });
      }
    }

    // =============================
    // 初回バインド
    // =============================
    if (!data.bound_account) {
      await supabase
        .from('licenses')
        .update({
          bound_account: account,
          bound_at: now.toISOString(),
          last_check_at: now.toISOString(),
          last_active_at:
            data.plan_type === 'paid' ? now.toISOString() : null,
        })
        .eq('id', data.id);

      return res.json({
        ok: true,
        reason: 'active_bound',
        bound_account: account,
        expires_at: expiresAt,
      });
    }

    // 別口座 → NG
    if (Number(data.bound_account) !== account) {
      return res.json({
        ok: false,
        reason: 'account_mismatch',
        bound_account: data.bound_account,
      });
    }

    // =============================
    // 正常（継続利用）
    // =============================
    const updateData = {
      last_check_at: now.toISOString(),
    };

    if (data.plan_type === 'paid') {
      updateData.last_active_at = now.toISOString();
    }

    await supabase
      .from('licenses')
      .update(updateData)
      .eq('id', data.id);

    return res.json({
      ok: true,
      reason: 'active',
      bound_account: data.bound_account,
      expires_at: expiresAt,
    });
  } catch (err) {
    console.error('❌ Unexpected Server Error:', err);
    return res.json({ ok: false, reason: 'server_error' });
  }
});

// ===================================================
// 動作チェック
// ===================================================
app.get('/', (req, res) => {
  res.send('API running');
});

app.get('/healthz', (req, res) => {
  res.send('ok');
});

app.get('/test-email', async (req, res) => {
  try {
    await sendEmail(
      'happytomo365@gmail.com',
      'SendGrid テストメール',
      'これは SendGrid が正常に動作していることを確認するテストメールです。'
    );
    res.send('テストメール送信完了！');
  } catch (e) {
    console.error(e);
    res.status(500).send('テストメール送信エラー');
  }
});

// ===================================================
// 起動
// ===================================================
const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
