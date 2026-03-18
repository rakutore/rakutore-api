// ===================================================
// 基本設定
// ===================================================
const express = require('express');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const sgMail = require('@sendgrid/mail');
const crypto = require('crypto');

const app = express();

// 静的ファイル
app.use('/admin.html', basicAuth)
app.use(express.static(path.join(__dirname, 'public')));

// ================================
// 配布EA ZIPファイル設定
// ================================
const EA_ZIP_PATH = 'Rakutore_Anchor_v5.2.zip';

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
// Supabase
// ===================================================
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
// ================================
// 管理画面ベーシック認証
// ================================
function basicAuth(req, res, next) {
  const auth = {
  login: process.env.ADMIN_USER,
  password: process.env.ADMIN_PASS
}

  const b64auth = (req.headers.authorization || '').split(' ')[1] || ''
  const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':')

  if (login && password && login === auth.login && password === auth.password) {
    return next()
  }

  res.set('WWW-Authenticate', 'Basic realm="Admin Area"')
  res.status(401).send('Authentication required.')
}

// ===================================================
// Webhook 以外のパース
// ===================================================
// Webhookより「前」に置く
app.use(express.urlencoded({ extended: true }));
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
// EA ライセンス認証 API（安定・実運用向け）
// - trial：デモのみ、バインドしない
// - paid ：デモOK（バインドしない）
//          リアルで初回だけバインド（口座 + broker + 環境）
//          以後は同じ口座なら server表記ゆれ（Live01/Live02等）でもOK
// ===================================================
// ===================================================
// EA ライセンス認証 API（安定・デバッグ版）
// ===================================================
app.post('/license/validate', async (req, res) => {
  try {
    // =============================
    // 入力取得（正規化）
    // =============================
 const emailRaw   = req.body?.email;
const accountRaw = req.body?.account;
const serverRaw  = req.body?.server;

const email = emailRaw
  ? String(emailRaw)
      .replace(/\x00/g, '')
      .replace(/ /g, '+')
      .trim()
      .toLowerCase()
  : null;

const server = serverRaw
  ? String(serverRaw)
      .replace(/\x00/g, '')
      .trim()
  : null;


    const account = accountRaw
      ? Number(String(accountRaw).replace(/\x00/g, '').replace(/\D/g, ''))
      : null;

    console.log('LICENSE INPUT:', { email, account, server });

    if (!email)   return res.json({ ok: false, reason: 'email_required' });
    if (!account) return res.json({ ok: false, reason: 'account_required' });
    if (!server)  return res.json({ ok: false, reason: 'server_required' });

    // =============================
    // DB取得（email）
    // =============================
    const { data, error } = await supabase
      .from('licenses')
      .select('*')
      .eq('email', email)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    console.log('LICENSE DB RESULT:', data);

    if (error) {
      console.error('❌ licenses select error:', error.message);
      return res.json({ ok: false, reason: 'server_error' });
    }
    if (!data) {
      console.warn('LICENSE NOT FOUND FOR EMAIL:', email);
      return res.json({ ok: false, reason: 'not_found' });
    }

    // =============================
    // 基本チェック
    // =============================
    const now = new Date();
    const expiresAt = data.expires_at ? new Date(data.expires_at) : null;

    if (!expiresAt) return res.json({ ok: false, reason: 'expires_at_required' });
    if (now >= expiresAt) return res.json({ ok: false, reason: 'expired' });
    if (data.status !== 'active') return res.json({ ok: false, reason: data.status });
    if (!data.plan_type) return res.json({ ok: false, reason: 'plan_type_invalid' });

    // =============================
    // デモ判定
    // - 将来EA側から env: "demo"/"live" を送れるようにもしておく（今送らなくてもOK）
    // =============================
    const envRaw = req.body?.env;
    const env = envRaw ? String(envRaw).toLowerCase().trim() : null;

    const isDemoRequest = env
      ? (env === 'demo')
      : server.toLowerCase().includes('demo');

    // =============================
    // trial：デモ限定・バインドしない
    // =============================
    if (data.plan_type === 'trial') {
      if (!isDemoRequest) {
        return res.json({ ok: false, reason: 'trial_demo_only' });
      }

      await supabase
        .from('licenses')
        .update({ last_check_at: now.toISOString() })
        .eq('id', data.id);

      return res.json({
        ok: true,
        reason: 'trial_ok',
        expires_at: expiresAt,
      });
    }

    // =============================
    // paid：デモOK（バインドしない）／リアル初回だけバインド／以後は口座固定
    // =============================
    if (data.plan_type === 'paid') {

      // デモは常にOK（バインドしない）
      if (isDemoRequest) {
        await supabase
          .from('licenses')
          .update({ last_check_at: now.toISOString() })
          .eq('id', data.id);

        return res.json({
          ok: true,
          reason: 'paid_demo_ok_not_bound',
          expires_at: expiresAt,
        });
      }

      // ① 既にバインド済み：口座が違えば申請が必要（無申請は動かない）
     if (data.bound_account) {
  if (Number(data.bound_account) !== account) {
    return res.json({
      ok: false,
      reason: 'account_mismatch_need_request',
      bound_account: data.bound_account,
      request_url: 'https://forms.gle/UUML7Mkyfuck6tdBA',
    });
  }

        // serverは表記ゆれがあるので「条件」にしない（ログ用途に更新はOK）
        await supabase
          .from('licenses')
          .update({
            bound_server: server,
            last_check_at: now.toISOString(),
            last_active_at: now.toISOString(),
          })
          .eq('id', data.id);

        return res.json({
          ok: true,
          reason: 'active',
          bound_account: data.bound_account,
          bound_server: server,
          expires_at: expiresAt,
        });
      }

      // ② 未バインド：リアル初回バインド（口座固定）
      await supabase
        .from('licenses')
        .update({
          bound_account: account,
          bound_server: server,
          bound_broker: server.split('-')[0],
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
        expires_at: expiresAt,
      });
    }

    return res.json({ ok: false, reason: 'plan_type_invalid' });

  } catch (err) {
    console.error('❌ /license/validate unexpected error:', err);
    return res.status(500).json({ ok: false, reason: 'server_error' });
  }
});


// ===================================================
// 管理用：入金確認 → 初回DL発行API（追加）
// ===================================================
app.post('/admin/confirm-payment', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ ok: false, reason: 'email_required' });
    }

    const token = await issueDownloadToken(email);
    if (!token) {
      return res.status(500).json({ ok: false, reason: 'token_failed' });
    }

    const downloadUrl = `https://api.rakutore.jp/download?token=${token}`;

    console.log('💰 初回DL発行:', email, downloadUrl);

    // 管理画面にURLを返す（メールは送らない）
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
// Cron用：デモ終了3日前メール送信（1日1回実行）
// ===================================================
app.post('/admin/cron/demo-ending-reminder', async (req, res) => {
  try {
    // ---- 簡易ガード（Cron専用）----
    const key = req.headers['x-cron-key'];
    if (process.env.CRON_KEY && key !== process.env.CRON_KEY) {
      return res.status(401).json({ ok: false, reason: 'unauthorized' });
    }

    // ---- JST基準で「今日 + 3日」----
    const now = new Date();
    const jstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    const target = new Date(jstNow.getTime() + 3 * 24 * 60 * 60 * 1000);

    const yyyy = target.getUTCFullYear();
    const mm = String(target.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(target.getUTCDate()).padStart(2, '0');
    const targetDate = `${yyyy}-${mm}-${dd}`;

    const start = `${targetDate}T00:00:00.000Z`;
    const end   = `${targetDate}T23:59:59.999Z`;

    // ---- 対象デモ取得 ----
    const { data: rows, error } = await supabase
      .from('licenses')
      .select('id,email,expires_at,plan_type,status')
      .eq('plan_type', 'trial')
      .eq('status', 'active')
      .gte('expires_at', start)
      .lte('expires_at', end);

    if (error) {
      console.error('❌ demo reminder query error:', error.message);
      return res.status(500).json({ ok: false, reason: 'query_failed' });
    }

    let sent = 0;

    for (const lic of rows || []) {
      const endDate = lic.expires_at
        ? String(lic.expires_at).slice(0, 10)
        : targetDate;

      await sendEmail(
        lic.email,
        `【Rakutore Anchor】デモ終了予定のお知らせ（${endDate}）`,
`Rakutore Anchor をお試しいただき、ありがとうございます。

現在ご利用中のデモ（14日間）は、
${endDate} をもって終了予定となっております。

■ デモ終了後について
・自動で課金されることはありません
・EAが突然動かなくなることもありません
・ご判断はご自身のタイミングで大丈夫です

■ 継続をご希望の場合
通常版（実運用）への切り替えをご希望の場合は、
本メールにそのままご返信ください。
ご案内をお送りします。

※ 本メールはご案内のみです。
※ 無理な勧誘・自動請求は一切行っておりません。

――――――――――
※このメールは、ご登録のメールアドレス（${lic.email}）宛にお送りしています。
――――――――――

Rakutore Anchor サポート
support@rakutore.jp
https://rakutore.jp`
      );

      sent++;
    }

    return res.json({
      ok: true,
      targetDate,
      matched: rows.length,
      sent,
    });

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


