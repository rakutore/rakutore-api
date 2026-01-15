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

// ================================
// 配布EA ZIPファイル設定
// ================================
const EA_ZIP_PATH = 'Rakutore_Anchor_v4.zip';

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

      const priceId =
        s?.display_items?.[0]?.price?.id ||
        s?.line_items?.data?.[0]?.price?.id ||
        null;

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

      if (email) {
        const token = await issueDownloadToken(email);

        if (token) {
          const downloadUrl = `https://api.rakutore.jp/download?token=${token}`;

          await sendEmail(
            email,
            '【Rakutore Anchor】EAダウンロードのご案内',
            `ご購入ありがとうございます。

以下のURLからEAをダウンロードできます。
（※ セキュリティ保護のため、1回のみ有効です）

${downloadUrl}

【ご注意】
・このURLは一度アクセスすると無効になります
・ダウンロード後は、必ずファイルを保存してください
・EAの利用可否は、ダウンロード回数ではなくライセンス認証によって管理されています
・再ダウンロードが必要な場合は support@rakutore.jp までご連絡ください。

Rakutore Anchor 運営`
          );

          console.log('📩 ダウンロードURL送信:', downloadUrl);
        }
      }
    }

    // ================================
    // invoice.paid（継続課金）
    // ================================
    else if (type === 'invoice.paid') {
      try {
        const invoice = event.data.object;

        const customerId = invoice.customer;
        const email = invoice.customer_email;

        const line = invoice.lines?.data?.[0];
        if (!line) {
          console.warn('⚠️ invoice.paid: no line items');
          return res.json({ received: true });
        }

        const expiresAt = line.period?.end
          ? new Date(line.period.end * 1000).toISOString()
          : null;

        const priceId = line.price?.id || line.plan?.id || null;

        let planType = 'paid';
        if (priceId === 'price_1SXAQUFWKU6pTKTIyPRFtc3Q') {
          planType = 'trial';
        }

        await upsertLicense({
          customerId,
          email,
          status: 'active',
          expiresAt,
          planType,
        });

        console.log('↪ handled: invoice.paid');
      } catch (err) {
        console.error('❌ invoice.paid error (ignored):', err);
      }
    }

    // ================================
    // subscription.deleted
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
// Webhook 以外のパース
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
      return res
        .status(400)
        .set('Content-Type', 'text/html; charset=utf-8')
        .send('無効なアクセスです。');
    }

    const { data, error } = await supabase
      .from('download_tokens')
      .select('*')
      .eq('token', token)
      .maybeSingle();

    if (error) {
      console.error('❌ download_tokens select error:', error.message);
      return res.status(500).send('サーバーエラーが発生しました');
    }

    if (!data) {
      return res
        .status(400)
        .set('Content-Type', 'text/html; charset=utf-8')
        .send('無効または期限切れのURLです。');
    }

    if (data.used_at) {
      return res
        .status(410)
        .set('Content-Type', 'text/html; charset=utf-8')
        .send('このURLはすでに使用されています。');
    }

    return res.send(`
      <html>
        <head>
          <meta charset="utf-8" />
          <title>Rakutore Anchor ダウンロード</title>
        </head>
        <body style="font-family: sans-serif; max-width: 600px; margin: 40px auto;">
          <h2>Rakutore Anchor ダウンロード</h2>
          <p>以下のボタンを押すとダウンロードが開始されます。</p>
          <p>このリンクは <strong>1回のみ</strong> 有効です。</p>

          <form method="POST" action="/download">
            <input type="hidden" name="token" value="${token}" />
            <button type="submit"
              style="padding: 12px 28px; font-size: 16px; background:#5c4c9b; color:#fff; border:none; border-radius:6px; cursor:pointer;">
              ダウンロードする
            </button>
          </form>
        </body>
      </html>
    `);
  } catch (err) {
    console.error('❌ /download (GET) unexpected error:', err);
    return res.status(500).send('サーバーエラーが発生しました');
  }
});

// ===================================================
// EAダウンロード処理（POST）
// ===================================================
app.post('/download', async (req, res) => {
  try {
    const token = req.body.token;

    if (!token) {
      return res
        .status(400)
        .set('Content-Type', 'text/html; charset=utf-8')
        .send('無効なアクセスです。');
    }

    const { data, error } = await supabase
      .from('download_tokens')
      .select('*')
      .eq('token', token)
      .maybeSingle();

    if (error) {
      console.error('❌ download_tokens select error:', error.message);
      return res.status(500).send('サーバーエラーが発生しました');
    }

    if (!data) {
      return res
        .status(400)
        .set('Content-Type', 'text/html; charset=utf-8')
        .send('無効または期限切れのURLです。');
    }

    if (data.used_at) {
      return res
        .status(410)
        .set('Content-Type', 'text/html; charset=utf-8')
        .send('このURLはすでに使用されています。');
    }

    const filePath = EA_ZIP_PATH;
    const SIGNED_URL_TTL = 60 * 60 * 24 * 30; // 30日

    const { data: signed, error: signedError } = await supabase.storage
      .from('ea-secure')
      .createSignedUrl(filePath, SIGNED_URL_TTL);

    if (signedError || !signed) {
      console.error('❌ createSignedUrl error:', signedError?.message);
      return res.status(500).send('ダウンロードURLの生成に失敗しました');
    }

    const now = new Date().toISOString();
    await supabase
      .from('download_tokens')
      .update({ used_at: now })
      .eq('id', data.id);

    return res.redirect(signed.signedUrl);
  } catch (err) {
    console.error('❌ /download (POST) unexpected error:', err);
    return res.status(500).send('サーバーエラーが発生しました');
  }
});

// ===================================================
// EA ライセンス認証 API（確定仕様版）
// - trial：デモのみ、バインドしない（メールは保存されている想定）
// - paid ：課金中ならデモでも動作OK（バインドしない）
//          リアルで初回起動した時だけバインド
//          以後は同じ口座ならデモ/リアルどちらもOK
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

    if (error) {
      console.error('❌ licenses select error:', error.message);
      return res.json({ ok: false, reason: 'server_error' });
    }

    if (!data) return res.json({ ok: false, reason: 'not_found' });

    const now = new Date();
    const expiresAt = data.expires_at ? new Date(data.expires_at) : null;

    if (data.status !== 'active')
      return res.json({ ok: false, reason: data.status });

    if (expiresAt && expiresAt < now)
      return res.json({ ok: false, reason: 'expired' });

    const serverLower = String(server).toLowerCase();
    const isDemo = serverLower.includes('demo');

    // =============================
    // trial：デモのみ（バインドしない）
    // =============================
    if (data.plan_type === 'trial') {
      if (!isDemo) {
        return res.json({ ok: false, reason: 'trial_demo_only' });
      }

      await supabase
        .from('licenses')
        .update({ last_check_at: now.toISOString() })
        .eq('id', data.id);

      return res.json({
        ok: true,
        reason: 'trial_demo_ok',
        bound_account: data.bound_account || null,
        expires_at: expiresAt,
      });
    }

    // =============================
    // paid：デモでもOK（バインドしない）
    // =============================
    if (data.plan_type === 'paid') {
      // まだバインドしていない＆デモ → 動作確認OK、ただしバインドしない
      if (!data.bound_account && isDemo) {
        await supabase
          .from('licenses')
          .update({ last_check_at: now.toISOString() })
          .eq('id', data.id);

        return res.json({
          ok: true,
          reason: 'paid_demo_ok_not_bound',
          bound_account: null,
          expires_at: expiresAt,
        });
      }

      // まだバインドしていない＆リアル → ここで初回バインド
   if (!data.bound_account && !isDemo) {
  await supabase
    .from('licenses')
    .update({
      bound_account: account,
      bound_server: server,
      bound_broker: server.split('-')[0], // 雑でOK
      bound_at: now.toISOString(),
      last_check_at: now.toISOString(),
      last_active_at: now.toISOString(),
    })
    .eq('id', data.id);

  return res.json({
    ok: true,
    reason: 'active_bound',
    bound_account: account,
    bound_server: server,
  });
}


      // すでにバインド済み → 口座一致ならOK（デモ/リアルどちらでも）
      if (Number(data.bound_account) !== account) {
        return res.json({
          ok: false,
          reason: 'account_mismatch',
          bound_account: data.bound_account,
        });
      }

      await supabase
        .from('licenses')
        .update({
          last_check_at: now.toISOString(),
          last_active_at: now.toISOString(),
        })
        .eq('id', data.id);

      return res.json({
        ok: true,
        reason: 'active',
        bound_account: data.bound_account,
        expires_at: expiresAt,
      });
    }

    // plan_type不明
    return res.json({ ok: false, reason: 'plan_type_invalid' });
  } catch (err) {
    console.error('❌ Unexpected Server Error:', err);
    return res.json({ ok: false, reason: 'server_error' });
  }
});

// ===================================================
// 管理用：ダウンロード再送API
// ===================================================
app.post('/admin/resend-download', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'email_required' });
    }

    const token = await issueDownloadToken(email);
    if (!token) {
      return res.status(500).json({ error: 'token_failed' });
    }

    const downloadUrl = `https://api.rakutore.jp/download?token=${token}`;

    await sendEmail(
      email,
      '【Rakutore Anchor】EAダウンロード再送のご案内',
      `ご連絡ありがとうございます。

以下のURLからEAを再ダウンロードできます。
（※ 1回のみ有効です）

${downloadUrl}

Rakutore Anchor 運営`
    );

    console.log('📩 再送ダウンロードURL:', downloadUrl);

    res.json({ ok: true });
  } catch (err) {
    console.error('❌ resend error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// ===================================================
// 動作チェック
// ===================================================
app.get('/', (req, res) => res.send('API running'));
app.get('/healthz', (req, res) => res.send('ok'));

// ===================================================
// 起動
// ===================================================
const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
