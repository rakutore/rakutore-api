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

const port = process.env.PORT || 8080;
app.listen(port, () => console.log('up'));
