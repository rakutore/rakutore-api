const express = require('express');
const { Pool } = require('pg');
const fs = require('fs');

const ca = fs.readFileSync(__dirname + '/supabase-ca.crt', 'utf8');const fs = require('fs');
const ca = fs.readFileSync(__dirname + '/supabase-ca.crt', 'utf8');

const app = express();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // いま使っている接続文字列
  ssl: { ca } // ← CA を渡して検証を有効にする
});

app.get('/healthz', (req, res) => res.send('ok'));

app.get('/dbcheck', async (req, res) => {
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

