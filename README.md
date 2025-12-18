# Rakutore Anchor バックエンド

## 概要
Rakutore Anchor（MT4 EA）の  
**決済・ライセンス管理・ダウンロード配布**を行うバックエンドです。

Stripe Webhook を受信し、  
Supabase の `licenses` テーブルを更新することで  
EA の利用可否を管理します。

---

## システム構成（概要）

- 決済：Stripe（サブスクリプション）
- バックエンド：Node.js / Express（Railway）
- データベース：Supabase
- 配布：ワンタイムダウンロードURL

---

## Stripe イベントの役割分担（重要）

### checkout.session.completed
**役割：初回購入完了時の処理**

このイベントで行うこと：
- ライセンスの新規作成（または初期化）
- ダウンロードURLの生成
- 購入者へのメール送信

※ ファイル配布はこのイベントのみで行う

---

### invoice.paid
**役割：継続課金の確認**

このイベントで行うこと：
- ライセンスを `active` に更新
- 有効期限（`expiresAt`）を延長（取得できる場合）

※ 以下は行わない  
- ダウンロードURLの発行  
- メール送信  
- 厳密な price 判定  

Stripe の invoice には price 情報が無い場合があるため、  
**必ず安全に処理すること（throw しない）**

---

## ライセンス管理（Supabase）

`licenses` テーブルが **唯一の正とする情報源**。

主な項目：
- customerId（Stripe Customer ID）
- email
- status（active / inactive）
- expiresAt
- planType（trial / paid）

EA や API 側の判定は、  
必ずこのテーブルの状態を基準に行う。

---

## 重要な設計ルール

- Stripe Webhook 内では例外を throw しない
- Stripe の payload は欠損がある前提で扱う
- 配布は checkout.session.completed のみ
- invoice.paid は継続確認のみ

---

## 運用メモ

- Railway 再起動時に webhook が再送されることがある
- 同じイベントが複数回届いても問題ない設計にする
- トラブル時はまず README を確認する

- 2025-12-18  
  invoice.paid の処理で price が無いケースがありサーバーが落ちた。
  Webhook では例外を出さない設計に修正し、README に役割分担を明記した。
