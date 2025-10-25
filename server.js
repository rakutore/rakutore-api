// server.js
const express = require('express');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: true,                       // ← 検証あり（= rejectUnauthorized: true と同等）
});

const app = express();

app.get('/healthz', (_, res) => res.send('ok'));

app.get('/dbcheck', async (_, res) => {
  try {
    const { rows } = await pool.query('select now() as now');
    res.json({ ok: true, now: rows[0].now });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log('up'));
