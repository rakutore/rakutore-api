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
- ---

## 運用メモ- 2025-12-18
- 初回テスト時、invoice.paid の処理で
  price が無いケースがありサーバーが落ちた。
- Webhook 内では必ず例外を握りつぶす設計に変更。
- 複数回購入は想定内として問題なし。  
  invoice.paid の処理で price が無いケースがありサーバーが落ちた。
  Webhook では例外を出さない設計に修正し、README に役割分担を明記した。
以下対策。
  ① server.js を「落ちない商用設計」に整理する
目的（これだけ覚えて）

Webhookで絶対にサーバーを落とさない

Stripeイベントごとに“やることを1つに固定”

Stripeイベントの最終役割分担（確定版）
✅ checkout.session.completed

役割：初回購入の完了処理

ここでやること：

ライセンス作成（or 初期化）

ダウンロードURL発行

メール送信

👉 配布はここだけ

✅ invoice.paid

役割：継続課金の確認

ここでやること：
- ZIP ファイル名は server.js で固定指定しているため、
  変更する場合はコード側も必ず修正すること。

ライセンスを active にする

有効期限を延ばす（あれば）

👉 何もしすぎない
👉 price判定はオマケ

ZIP名は固定。中身でバージョン管理する
- 口座変更申請は Googleフォームで受付。
  新規回答はメール通知＋Zoho転送で確認する。
## KO（口座変更）対応メモ

### 概要
Googleフォーム「口座変更申請」の回答は、スプレッドシート「フォームの回答 6」に自動記録する。
運用開始直後は、対応連絡（ユーザー返信）は手動で行う。

### 通知（管理者）
- フォーム送信時に Apps Script（onFormSubmit）で support@rakutore.jp へ通知メールを送る。
- メール本文は e.namedValues を使い、項目名が変わっても通知できる方式。

### 書式（マス/罫線）の自動適用
- 新しい回答行が追加された際、追加行に対して「2行目」をテンプレとして書式をコピーする。
- 罫線（マス）は setBorder(true, true, true, true, true, true) で確実に付与する。
- 追加行の特定には e.range を使用（lastRow方式より安定）。

### 対応済み管理
- 「フォームの回答 6」の右端に「対応済み」チェックボックス列を追加して管理する（フォーム項目にはしない）。
- 対応完了後のユーザー連絡は当面手動。
  ※将来的に、チェックONで自動送信（onEdit）も可能。

### 運用ルール（崩れ防止）
- 回答シートは基本ログ専用。途中行を Delete で空にしない（必要なら「行を削除」）。
- テンプレ行（2行目）の書式が新規行へ反映されるため、2行目の見た目を基準に整える。
https://docs.google.com/spreadsheets/d/1SQdYc7V9jKQXAE6tbpGcFmBokH2REi1InvJSQpEkcW8/edit?resourcekey=&gid=804934217#gid=804934217

Rakutore_Anchor.zip　　Upしたファイルの名前。中身の名前　Rakutore_Anchor.v4これだとうまくいかないのでZIPを新しく変えるたびに
ZIP名変更する。
// ================================
// 配布EA ZIPファイル設定
// ================================
const EA_ZIP_PATH = 'Rakutore_Anchor_v4.zip';　　　ここを変える。

★「落ち着いたらやること」メモ（今はやらなくていい）

将来やるなら、こういう順番が楽👇

Zoho or SendGrid で
support@rakutore.jp 送信に統一

Apps Script は

通知 or API呼び出しだけ担当

メール文面を

受付

変更完了

追加確認
に分けてテンプレ化

※ でもこれは売上・件数が増えてからで十分
現在の構成（①で運用）

フォーム → スプレッドシート

Apps Script → Zoho通知

自動返信メール：systemアドレスから送信

なぜこの構成にしているか

初期運用優先／安定重視

将来の改善予定（未対応）

差出人を support@rakutore.jp に統一

メールテンプレ分離 など
