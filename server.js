const express = require('express');
const { Pool } = require('pg');

const app = express();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // Railwayの環境変数から読む
  ssl: { rejectUnauthorized: false },         // CAなしでOKにする（まずはこれで通す）
});

app.get('/healthz', (_, res) => res.send('ok'));

app.get('/dbcheck', async (_, res) => {
  try {
    const { rows } = await pool.query('select now() as now');
    res.json({ ok: true, now: rows[0].now });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ===== ここから TODO API ===== */

// 一覧
app.get('/todos', async (_, res) => {
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
app.post('/todos', async (req, res) => {
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

// 更新（title / done のどちらか、または両方）
app.patch('/todos/:id', async (req, res) => {
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
app.delete('/todos/:id', async (req, res) => {
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
