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
  limit: 10,             // 書き込み 10回/分/IP（必要なら 20 に）
  standardHeaders: true,
  legacyHeaders: false,
});

// ---- API キー認証（更新系で使用） -------------------------------
const API_KEY = (process.env.API_KEY || '').trim();
function requireKey(req, res, next) {
  const got = (req.get('x-api-key') || '').trim();
  if (got !== API_KEY) return res.status(401).json({ ok: false, error: 'unauthorized' });
  next();
}

// ---- DB 接続（CA で厳格検証） ---------------------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,               // Poolerでも直結でもOK
  ssl: { ca: process.env.PG_CA, rejectUnauthorized: true }, // Variables: PG_CA に crt 全文
});

// ---- 公開ヘルスチェック（レート制限付き・一度だけ定義） ---------
app.get('/healthz', readLimiter, (_, res) => res.send('ok'));

app.get('/dbcheck', readLimiter, async (_, res) => {
  try {
    const { rows } = await pool.query('select now() as now');
    res.json({ ok: true, now: rows[0].now });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// （任意）認証デバッグ：問題なければ後で削除可
app.get('/debug/auth', readLimiter, (req, res) => {
  const sent = (req.get('x-api-key') || '').trim();
  const expected = API_KEY;
  res.json({ sent, expected_len: expected.length, match: sent === expected });
});

// ---- TODO API ---------------------------------------------------
// 一覧：公開（閲覧のみ鍵なし）＋ 読み取りレート制限
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

// 追加：鍵必須 + 書き込みレート制限
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

// 更新：鍵必須 + 書き込みレート制限
app.patch('/todos/:id', writeLimiter, requireKey, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'invalid id' });

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

// 削除：鍵必須 + 書き込みレート制限
app.delete('/todos/:id', writeLimiter, requireKey, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'invalid id' });

    const { rowCount } = await pool.query('delete from todos where id = $1', [id]);
    if (!rowCount) return res.status(404).json({ ok: false, error: 'not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------
const port = process.env.PORT || 8080;
app.listen(port, () => console.log('up'));
