// server.js（健康チェックだけ返す最小版）
const express = require("express");
const app = express();
app.get("/healthz", (req, res) => res.send("ok")); // ← これが見えれば稼働OK
app.listen(process.env.PORT || 8080, () => console.log("up"));
