const express = require('express');
const { Pool } = require('pg');

const app = express();

// JSON ボディを受け取るために必要
app.use(express.json());

// ★ pool はトップレベル（関数の外）で定義！ ここが重要
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { ca: process.env.PG_CA, rejectUnauthorized: true }, // ← 厳格化
});

// ---- 公開のヘルスチェック類（認証なし）----
app.get('/healthz', (_, res) => res.send('ok'));
app.get('/dbcheck', async (_, res) => {
  try {
    const { rows } = await pool.query('select now() as now');
    res.json({ ok: true, now: rows[0].now });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 認証デバッグ用（送ったキーが一致してるか確認するだけ）
app.get('/debug/auth', (req, res) => {
  const sent = req.get('x-api-key') || '';
  const expected = process.env.API_KEY || '';
  res.json({ sent, expected_len: expected.length, match: sent === expected });
});

// ---- API キー認証ミドルウェア（/todos だけ保護）----
const requireKey = (req, res, next) => {
  if ((req.get('x-api-key') || '') !== (process.env.API_KEY || '')) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
};

/* ===== ここから TODO API（認証必須） ===== */

// 一覧
app.get('/todos', requireKey, async (_, res) => {
  try {
    const { rows } = await pool.query(
      'select id, title, done, created_at from todos order by id desc'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 追加
app.post('/todos', requireKey, async (req, res) => {
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
app.patch('/todos/:id', requireKey, async (req, res) => {
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

// 削除
app.delete('/todos/:id', requireKey, async (req, res) => {
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
/* ===== TODO API ここまで ===== */

const port = process.env.PORT || 8080;
app.listen(port, () => console.log('up'));
