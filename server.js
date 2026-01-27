/**
 * Rakutore Anchor API (Express)
 * ---------------------------------------------------
 * ✅ 反映済み（あなたが決めた方針）
 * - trial：EAを「初めて起動して認証が通った瞬間」から14日開始（自動でexpires_at確定）
 * - paid ：月額（expires_at）＋猶予3日（grace_until）で停止判定
 * - DL   ：download_tokenは1回のみ＋30日で期限切れ（download_tokens.expires_atで判定）
 * - デモ終了3日前メール：licenses.expires_at基準で送信（二重送信防止：renewal_notice_3d_sent_at）
 *
 * ✅ 事前にDBに追加しておく列（最低限）
 * --- licenses ---
 *  - first_seen_at timestamptz
 *  - grace_until timestamptz
 *  - renewal_notice_3d_sent_at timestamptz
 *  - downloaded_at timestamptz   (任意：DL実績。入れておくと便利)
 * --- download_tokens ---
 *  - expires_at timestamptz
 *
 * ※ Supabase Storage bucket: ea-secure / file: Rakutore_Anchor_v4.zip
 */
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
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || '');
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET || '';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ===================================================
// Helpers
// ===================================================
function cleanEmail(raw) {
  return raw ? String(raw).replace(/\x00/g, '').trim().toLowerCase() : null;
}
function cleanServer(raw) {
  return raw ? String(raw).replace(/\x00/g, '').trim() : null;
}
function cleanAccount(raw) {
  if (!raw) return null;
  const s = String(raw).replace(/\x00/g, '').replace(/\D/g, '');
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function isDemoServer(server) {
  return String(server || '').toLowerCase().includes('demo');
}
function extractBroker(server) {
  if (!server) return null;
  return String(server).split('-')[0] || null;
}
function extractEnv(server) {
  const s = String(server || '').toLowerCase();
  if (s.includes('demo')) return 'demo';
  if (s.includes('live')) return 'live';
  return 'unknown';
}
function isSameEnvAndBroker(boundServer, currentServer, boundBroker) {
  const env1 = extractEnv(boundServer);
  const env2 = extractEnv(currentServer);
  if (env1 !== 'unknown' && env2 !== 'unknown' && env1 !== env2) return false;

  const b1 = boundBroker || extractBroker(boundServer);
  const b2 = extractBroker(currentServer);
  if (b1 && b2 && b1 !== b2) return false;

  return true;
}

// ===================================================
// ✅ 現在配布するZIPパスをDBから取得
// app_settings: key='ea_zip_path', value='Rakutore_Anchor_v5.zip'
// ===================================================
async function getCurrentZipPath() {
  const { data, error } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', 'ea_zip_path')
    .maybeSingle();

  if (error) {
    console.error('❌ app_settings select error:', error.message);
    return null;
  }
  if (!data?.value) return null;

  // ルート直下のファイル名のみ想定（例：Rakutore_Anchor_v5.zip）
  return String(data.value).trim();
}

// ===================================================
// ダウンロード用トークン発行（1回だけ有効）＋30日失効
// download_tokens: { email, token, expires_at, used_at, created_at ... }
// ===================================================
async function issueDownloadToken(email) {
  try {
    const token = crypto.randomBytes(16).toString('hex');

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const { error } = await supabase
      .from('download_tokens')
      .insert({ email, token, expires_at: expiresAt.toISOString() });

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
// Stripe Webhook（今は手売り運用なら使わなくてもOK）
// ===================================================
app.post(
  '/stripe/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    if (!endpointSecret) return res.status(400).send('Webhook not configured');

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

    if (type === 'checkout.session.completed') {
      const s = event.data.object;
      const customerId = s.customer;
      const email =
        (s.customer_details && s.customer_details.email) ||
        s.customer_email ||
        null;

      await upsertLicense({
        customerId,
        email,
        status: 'active',
        expiresAt: null,
        planType: 'paid',
      });

      if (email) {
        const token = await issueDownloadToken(cleanEmail(email));
        if (token) {
          const downloadUrl = `https://api.rakutore.jp/download?token=${token}`;
          await sendEmail(
            email,
            '【Rakutore Anchor】EAダウンロードのご案内',
            `ご購入ありがとうございます。

以下のURLからEAをダウンロードできます。
（※ 1回のみ有効／30日で期限切れ）

${downloadUrl}

Rakutore Anchor 運営`
          );
        }
      }
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

    // ✅ token期限（30日）
    if (data.expires_at && new Date(data.expires_at) < new Date()) {
      return res
        .status(410)
        .set('Content-Type', 'text/html; charset=utf-8')
        .send('無効または期限切れのURLです。');
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
// - 配布ZIPは app_settings.ea_zip_path を参照（v5/v6切替はDBだけ）
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

    // ✅ token期限（30日）
    if (data.expires_at && new Date(data.expires_at) < new Date()) {
      return res
        .status(410)
        .set('Content-Type', 'text/html; charset=utf-8')
        .send('無効または期限切れのURLです。');
    }

    // ✅ 現在配布するZIPをDBから取得
    const filePath = await getCurrentZipPath();
    if (!filePath) {
      console.error('❌ ea_zip_path not set');
      return res.status(500).send('配布設定が見つかりませんでした');
    }

    // 署名URLは短め推奨（キャッシュ事故を減らす）
    const SIGNED_URL_TTL = 60 * 10; // 10分

    const { data: signed, error: signedError } = await supabase.storage
      .from('ea-secure')
      .createSignedUrl(filePath, SIGNED_URL_TTL);

    if (signedError || !signed) {
      console.error('❌ createSignedUrl error:', signedError?.message);
      return res.status(500).send('ダウンロードURLの生成に失敗しました');
    }

    const nowIso = new Date().toISOString();

    // tokenを1回で無効化
    await supabase
      .from('download_tokens')
      .update({ used_at: nowIso })
      .eq('id', data.id);

    // 任意：licenses側に downloaded_at を記録（email一致で）
    if (data.email) {
      await supabase
        .from('licenses')
        .update({ downloaded_at: nowIso })
        .eq('email', cleanEmail(data.email));
    }

    return res.redirect(signed.signedUrl);
  } catch (err) {
    console.error('❌ /download (POST) unexpected error:', err);
    return res.status(500).send('サーバーエラーが発生しました');
  }
});

// ===================================================
// EA ライセンス認証 API
// - trial：デモのみ、初回起動で14日開始（first_seen_at/expires_at確定）
// - paid ：猶予3日(grace_until)を考慮
// ===================================================
app.post('/license/validate', async (req, res) => {
  try {
    const email = cleanEmail(req.body?.email);
    const server = cleanServer(req.body?.server);
    const account = cleanAccount(req.body?.account);

    console.log('LICENSE INPUT:', { email, account, server });

    if (!email) return res.json({ ok: false, reason: 'email_required' });
    if (!account) return res.json({ ok: false, reason: 'account_required' });
    if (!server) return res.json({ ok: false, reason: 'server_required' });

    const { data, error } = await supabase
      .from('licenses')
      .select('*')
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
    const graceUntil = data.grace_until ? new Date(data.grace_until) : null;

    if (data.status !== 'active') return res.json({ ok: false, reason: data.status });
    if (!data.plan_type) return res.json({ ok: false, reason: 'plan_type_invalid' });

    const isDemo = isDemoServer(server);

    // -----------------------------
    // trial：初回起動で開始確定
    // -----------------------------
    if (data.plan_type === 'trial') {
      if (!isDemo) return res.json({ ok: false, reason: 'trial_demo_only' });

      // 初回だけ開始確定
      if (!data.first_seen_at) {
        const trialExpires = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

        const { error: uerr } = await supabase
          .from('licenses')
          .update({
            first_seen_at: now.toISOString(),
            expires_at: trialExpires.toISOString(),
            last_check_at: now.toISOString(),
          })
          .eq('id', data.id);

        if (uerr) {
          console.error('❌ trial start update error:', uerr.message);
          return res.json({ ok: false, reason: 'server_error' });
        }

        return res.json({ ok: true, reason: 'trial_started', expires_at: trialExpires.toISOString() });
      }

      // 期限切れ（trialは猶予なし）
      if (expiresAt && expiresAt < now) return res.json({ ok: false, reason: 'expired' });

      await supabase.from('licenses').update({ last_check_at: now.toISOString() }).eq('id', data.id);
      return res.json({ ok: true, reason: 'trial_demo_ok', expires_at: expiresAt ? expiresAt.toISOString() : null });
    }

    // -----------------------------
    // paid：猶予3日を考慮
    // -----------------------------
    if (data.plan_type === 'paid') {
      if (expiresAt && expiresAt < now) {
        if (!graceUntil || graceUntil < now) {
          return res.json({ ok: false, reason: 'expired' });
        }
      }

      const inGrace = !!(expiresAt && expiresAt < now && graceUntil && graceUntil >= now);

      // ① バインド済み
      if (data.bound_account) {
        const accountOk = Number(data.bound_account) === account;
        const serverOk =
          !data.bound_server ||
          data.bound_server === server ||
          isSameEnvAndBroker(data.bound_server, server, data.bound_broker);

        if (!accountOk || !serverOk) {
          return res.json({
            ok: false,
            reason: 'account_or_server_mismatch',
            bound_account: data.bound_account,
            bound_server: data.bound_server,
          });
        }

        await supabase
          .from('licenses')
          .update({ last_check_at: now.toISOString(), last_active_at: now.toISOString() })
          .eq('id', data.id);

        return res.json({
          ok: true,
          reason: inGrace ? 'active_grace' : 'active',
          bound_account: data.bound_account,
          bound_server: data.bound_server,
          expires_at: expiresAt ? expiresAt.toISOString() : null,
          grace_until: graceUntil ? graceUntil.toISOString() : null,
        });
      }

      // ② 未バインド：デモならOK（バインドしない）
      if (isDemo) {
        await supabase.from('licenses').update({ last_check_at: now.toISOString() }).eq('id', data.id);
        return res.json({
          ok: true,
          reason: inGrace ? 'paid_demo_ok_not_bound_grace' : 'paid_demo_ok_not_bound',
          expires_at: expiresAt ? expiresAt.toISOString() : null,
          grace_until: graceUntil ? graceUntil.toISOString() : null,
        });
      }

      // リアル初回バインド
      await supabase
        .from('licenses')
        .update({
          bound_account: account,
          bound_server: server,
          bound_broker: extractBroker(server),
          bound_at: now.toISOString(),
          last_check_at: now.toISOString(),
          last_active_at: now.toISOString(),
        })
        .eq('id', data.id);

      return res.json({
        ok: true,
        reason: inGrace ? 'active_bound_grace' : 'active_bound',
        bound_account: account,
        bound_server: server,
        expires_at: expiresAt ? expiresAt.toISOString() : null,
        grace_until: graceUntil ? graceUntil.toISOString() : null,
      });
    }

    return res.json({ ok: false, reason: 'plan_type_invalid' });
  } catch (err) {
    console.error('❌ Unexpected Server Error:', err);
    return res.json({ ok: false, reason: 'server_error' });
  }
});

// ===================================================
// 管理用：入金確認 → 初回DL発行API
// ===================================================
app.post('/admin/confirm-payment', async (req, res) => {
  try {
    const { email: emailRaw } = req.body;
    const email = cleanEmail(emailRaw);
    if (!email) return res.status(400).json({ ok: false, reason: 'email_required' });

    const token = await issueDownloadToken(email);
    if (!token) return res.status(500).json({ ok: false, reason: 'token_failed' });

    const downloadUrl = `https://api.rakutore.jp/download?token=${token}`;
    console.log('💰 初回DL発行:', email, downloadUrl);

    return res.json({ ok: true, downloadUrl });
  } catch (err) {
    console.error('❌ confirm-payment error:', err);
    return res.status(500).json({ ok: false, reason: 'server_error' });
  }
});

// ===================================================
// 管理用：ダウンロード再送API
// ===================================================
app.post('/admin/resend-download', async (req, res) => {
  try {
    const { email: emailRaw } = req.body;
    const email = cleanEmail(emailRaw);
    if (!email) return res.status(400).json({ ok: false, reason: 'email_required' });

    const token = await issueDownloadToken(email);
    if (!token) return res.status(500).json({ ok: false, reason: 'token_failed' });

    const downloadUrl = `https://api.rakutore.jp/download?token=${token}`;

    await sendEmail(
      email,
      '【Rakutore Anchor】EAダウンロード再送のご案内',
      `ご連絡ありがとうございます。

以下のURLからEAを再ダウンロードできます。
（※ 1回のみ有効／30日で期限切れ）

${downloadUrl}

Rakutore Anchor 運営`
    );

    console.log('📩 再送ダウンロードURL:', downloadUrl);
    return res.json({ ok: true });
  } catch (err) {
    console.error('❌ resend error:', err);
    return res.status(500).json({ ok: false, reason: 'server_error' });
  }
});

// ===================================================
// Cron用：デモ終了3日前メール（1日1回）
// - DB expires_at 基準
// - 二重送信防止：renewal_notice_3d_sent_at
// ===================================================
app.post('/admin/cron/demo-ending-reminder', async (req, res) => {
  try {
    const key = req.headers['x-cron-key'];
    if (process.env.CRON_KEY && key !== process.env.CRON_KEY) {
      return res.status(401).json({ ok: false, reason: 'unauthorized' });
    }

    const now = new Date();
    const jstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    const target = new Date(jstNow.getTime() + 3 * 24 * 60 * 60 * 1000);

    const yyyy = target.getUTCFullYear();
    const mm = String(target.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(target.getUTCDate()).padStart(2, '0');
    const targetDate = `${yyyy}-${mm}-${dd}`;

    const start = `${targetDate}T00:00:00.000Z`;
    const end = `${targetDate}T23:59:59.999Z`;

    const { data: rows, error } = await supabase
      .from('licenses')
      .select('id,email,expires_at,plan_type,status,renewal_notice_3d_sent_at')
      .eq('plan_type', 'trial')
      .eq('status', 'active')
      .is('renewal_notice_3d_sent_at', null)
      .gte('expires_at', start)
      .lte('expires_at', end);

    if (error) {
      console.error('❌ demo reminder query error:', error.message);
      return res.status(500).json({ ok: false, reason: 'query_failed' });
    }

    let sent = 0;
    const sentAt = new Date().toISOString();

    for (const lic of rows || []) {
      const endDate = lic.expires_at ? String(lic.expires_at).slice(0, 10) : targetDate;

      await sendEmail(
        lic.email,
        `【Rakutore Anchor】デモ終了予定のお知らせ（${endDate}）`,
        `Rakutore Anchor をお試しいただき、ありがとうございます。

現在ご利用中のデモ（14日間）は、
${endDate} をもって終了予定となっております。

■ 継続をご希望の場合
通常版（実運用）への切り替えをご希望の場合は、
本メールにそのままご返信ください。

Rakutore Anchor サポート
support@rakutore.jp
https://rakutore.jp`
      );

      await supabase
        .from('licenses')
        .update({ renewal_notice_3d_sent_at: sentAt })
        .eq('id', lic.id);

      sent++;
    }

    return res.json({ ok: true, targetDate, matched: (rows || []).length, sent });
  } catch (err) {
    console.error('❌ demo-ending-reminder error:', err);
    return res.status(500).json({ ok: false, reason: 'server_error' });
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
