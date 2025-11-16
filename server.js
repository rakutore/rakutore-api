const express = require('express');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

// Railway/Proxy 配下でクライアントIPを正しく見るため
app.set('trust proxy', 1);

// ---- レート制限 -------------------------------------------------
const readLimiter = rateLimit({
  windowMs: 60 * 1000,   // 1分
  limit: 60,             // 読み取り 60回/分/IP
  standardHeaders: true,
  legacyHeaders: false,
});

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,   // 1分
  limit: 10,             // 書き込み 10回/分/IP
  standardHeaders: true,
  legacyHeaders: false,
});

// ---- API キー認証（更新系で使用） -------------------------------
const API_KEY = (process.env.API_KEY || '').trim();
function requireKey(req, res, next) {
  const got = (req.get('x-api-key') || '').trim();
  if (got !== API_KEY) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
}

// ---- DB 接続（CA で厳格検証） ---------------------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    ca: process.env.PG_CA,
    rejectUnauthorized: true
  },
});

// ---- 公開ヘルスチェック（レート制限付き） ----------------------
app.get('/healthz', readLimiter, (_, res) => res.send('ok'));

app.get('/dbcheck', readLimiter, async (_, res) => {
  try {
    const { rows } = await pool.query('select now() as now');
    res.json({ ok: true, now: rows[0].now });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 認証デバッグ（必要なければ削除OK）
app.get('/debug/auth', readLimiter, (req, res) => {
  const sent = (req.get('x-api-key') || '').trim();
  const expected = API_KEY;
  res.json({ sent, expected_len: expected.length, match: sent === expected });
});

// ---- ライセンス確認 API -----------------------------------------
app.get('/license/status', readLimiter, async (req, res) => {
  const customerId = req.query.customer_id;   // ← ここポイント

  if (!customerId) {
    return res.status(400).json({ ok: false, error: 'customer_id is required' });
  }

  try {
    const { rows } = await pool.query(
      'SELECT status, expires_at FROM licenses WHERE stripe_customer_id = $1 ORDER BY created_at DESC LIMIT 1',
      [customerId]
    );

    // レコードなし → まだ購入していない
    if (rows.length === 0) {
      return res.json({ status: 'none' });
    }

    const license = rows[0];

    const now = new Date();
    const expire = license.expires_at ? new Date(license.expires_at) : null;

    let status = license.status; // DBのstatusを基本とする

    if (expire) {
      // expires_at が入っている場合は期限もチェック
      status = expire > now ? 'active' : 'expired';
    }

    return res.json({
      status,
      expires_at: license.expires_at
    });
  } catch (err) {
    console.error('license error:', err);
    res.status(500).json({ ok: false, error: 'internal server error' });
  }
});


// ---- TODO API ---------------------------------------------------
// 一覧：公開（読み取りのみ鍵なし）
app.get('/todos', readLimiter, async (_, res) => {
  try {
    const { rows } = await pool.query(
      'select id, title, done, created_at from todos order by id desc'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 追加：鍵必須
app.post('/todos', writeLimiter, requireKey, async (req, res) => {
  try {
    const { title } = req.body || {};
    if (!title) return res.status(400).json({ ok: false, error: 'title required' });

    const { rows } = await pool.query(
      'insert into todos (title) values ($1) returning id, title, done, created_at',
      [title]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 更新
app.patch('/todos/:id', writeLimiter, requireKey, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ ok: false, error: 'invalid id' });
    }

    const { title = null, done = null } = req.body || {};
    const { rows } = await pool.query(
      `update todos
         set title = coalesce($1, title),
             done  = coalesce($2, done)
       where id = $3
       returning id, title, done, created_at`,
      [title, done, id]
    );

    if (!rows.length) return res.status(404).json({ ok: false, error: 'not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 削除
app.delete('/todos/:id', writeLimiter, requireKey, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ ok: false, error: 'invalid id' });
    }

    const { rowCount } = await pool.query('delete from todos where id = $1', [id]);
    if (!rowCount) return res.status(404).json({ ok: false, error: 'not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---- 起動 -------------------------------------------------------
const port = process.env.PORT || 8080;
app.listen(port, () => console.log('API running on port', port));
