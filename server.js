const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

// === APIキー認証（更新系だけに使う） ==========================
const API_KEY = (process.env.API_KEY || '').trim();
function requireKey(req, res, next) {
  const got = (req.get('x-api-key') || '').trim();
  if (got !== API_KEY) return res.status(401).json({ ok: false, error: 'unauthorized' });
  next();
}

// === DB接続（CAで厳格検証） ===================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,               // Poolerでも直結でもOK
  ssl: { ca: process.env.PG_CA, rejectUnauthorized: true }, // Railway Variables: PG_CA に crt 全文
});

// === 公開ヘルスチェック ========================================
app.get('/healthz', (_, res) => res.send('ok'));
app.get('/dbcheck', async (_, res) => {
  try {
    const { rows } = await pool.query('select now() as now');
    res.json({ ok: true, now: rows[0].now });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// （任意）認証デバッグ：問題なければ後で削除可
app.get('/debug/auth', (req, res) => {
  const sent = (req.get('x-api-key') || '').trim();
  const expected = API_KEY;
  res.json({ sent, expected_len: expected.length, match: sent === expected });
});

// === TODO API =================================================
// 一覧：公開（閲覧のみ鍵なし）
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

// 追加：鍵必須
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

// 更新：鍵必須
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

// 削除：鍵必須
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

// ==============================================================
const port = process.env.PORT || 8080;
app.listen(port, () => console.log('up'));
