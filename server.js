// server.js（健康チェックだけ返す最小版）
const express = require("express");
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const app = express();
app.get("/healthz", (req, res) => res.send("ok")); // ← これが見えれば稼働OK
app.listen(process.env.PORT || 8080, () => console.log("up"));
app.get('/dbcheck', async (req, res) => {
  try {
    const { rows } = await pool.query('select now() as now');
    res.json({ ok: true, now: rows[0].now });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});
