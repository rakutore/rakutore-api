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
変更後チェックリスト（必須）
共通ルール

★★★★何か1つでも設定・コード・アカウントを触ったら必ず実施★★★★

判断は「1回目でダメでも、2回目で確認」

テストは 本番と同じ導線 で行う

① フォーム／スプレッドシート／メール（自動処理）
フォーム送信テスト（必須）

テスト用データで 1回送信する。

確認項目

 スプレッドシートに新しい行が追加される

 追加された行の書式（罫線・背景・チェックボックス）が2行目と同じ

 Zoho（support@rakutore.jp
）に通知メールが届く

 ユーザー（入力したメール）に「受付メール」が届く

※ Zohoに来ない場合
→ シート手入力／テスト送信ではないか確認
→ Apps Script トリガーが「自分（rakutore.system）」で有効か確認

② Apps Script（トリガー・権限）
トリガー確認

 有効なトリガーは 1本のみ

 オーナーが rakutore.system

 イベント：スプレッドシート → フォーム送信時

 エラー率が 0%

権限確認（変更直後のみ）

 Google の警告画面で「詳細 → 続行」を許可済み

 MailApp の送信権限が許可されている

③ メール送信（表示・信頼性）

 差出人名が「Rakutore Anchor Support」になっている

 件名が正しい（受付／変更完了など）

 本文に「自動送信」である旨が明記されている

※ 現在は rakutore.system@gmail.com から送信（仕様）

④ EA（MT4/MT5）認証チェック（影響がある変更時）
テスト口座で確認

 ライセンス認証が通る

 EAが正常に稼働する

 既存ユーザーの設定が壊れていない

※ サーバー名・口座番号まわりを触った場合は必須

⑤ 最終確認（安心用）

 同じテストを もう1回 行い、再現性がある

 README に変更内容を簡単に追記した

テスト用固定データ（推奨）

毎回同じ内容で送信する。

名前：テスト太郎

メール：自分の確認用メール

口座番号：1234567

サーバー：XM

理由：テスト

メモ

トリガー変更・オーナー変更直後は 1回目が不安定なことがある

2回目以降に正常なら問題なし

デモ追加オプションの件了解。README にそのまま貼れる形で、「将来拡張（allow_demo）」も含めた 運用仕様＋DB＋APIの要点 をまとめて置けるテンプレを書いたよ。
（あなたの今の方針：基本リアル専用／デモは確認用 or 追加オプション、に沿ってる）

# Rakutore Anchor – License System (Supabase)

このREADMEは `licenses` テーブルと `/license/validate` の仕様、および運用ルールをまとめたものです。

---

## 1. 目的

- 不正利用（コピー・配布）を防ぐ
- サブスク/売り切りどちらでも運用できる構造にする
- デモは原則「動作確認用」に留め、リアル稼働は口座バインドで保護する

---

## 2. 基本仕様（最終形）

### 入力（EA → API）
- `email` : 購入時メール
- `account`: MT4口座番号
- `server` : 取引サーバー名（例: `AxioryAsia-02Live`, `AxioryAsia-02Demo`）

### 判定ルール

#### trial（体験）
- **デモのみ利用可**
- バインドしない（`bound_*` は保持しない）
- リアルで起動したら `trial_demo_only` で拒否

#### paid（本契約）
- **リアルで初回起動したときだけバインド**
  - `bound_account` / `bound_server` / `bound_broker` を保存
- 以後は **同一口座＋同一サーバー** のみ許可
- デモは「未バインドならOK（動作確認）」  
  バインド後は原則デモに戻れない（セキュリティ重視）

---

## 3. licenses テーブル（主な列）

- `email` (text)
- `status` (license_status) : `inactive | active | canceled` など
- `plan_type` (text) : `trial | paid`
- `expires_at` (timestamptz) : 有効期限（サブスク用。売り切りはNULLでも可）
- `bound_account` (int8) : リアル初回起動でバインド
- `bound_server` (text) : リアル初回起動でバインド
- `bound_broker` (text) : `server.split('-')[0]` 等で保存
- `bound_at` (timestamptz)
- `last_check_at` (timestamptz)
- `last_active_at` (timestamptz)

### 注意（重要）
- `bound_server` / `bound_broker` に **空文字（EMPTY）** が入るとミスマッチ地雷になる  
  → 未バインドは `NULL` を正とする

---

## 4. 推奨SQL（初期セット）

### 4.1 status デフォルト（安全側）
```sql
alter table licenses
alter column status set default 'inactive';

4.2 plan_type を必須化（事故防止）
alter table licenses
alter column plan_type set not null;

4.3 status を必須化（任意だが推奨）
alter table licenses
alter column status set not null;

4.4 EMPTY（空文字）をNULLへ補正（事故修復）
update licenses
set bound_server = null
where bound_server = '';

update licenses
set bound_broker = null
where bound_broker = '';

5. 将来拡張（オプション）: allow_demo スイッチ

要望が増えたら「デモ利用を有料オプション化」するためのスイッチ。

5.1 列追加
alter table licenses
add column allow_demo boolean default false;

5.2 使い方（運用）

通常：allow_demo=false（リアル専用）

追加料金/特別対応：allow_demo=true（デモ利用許可）

PAYJP webhook 等で課金確認後に allow_demo=true にする運用が可能。

6. 運用フロー（想定）

決済完了

licenses レコード作成（inactive）

email, plan_type を保存

課金確認（PAYJP webhook 等）

status=active に更新

EA 初回起動

デモ（trial/paid未バインド）: 動作確認OK

リアル（paid未バインド）: 初回バインドして稼働開始

継続/解約

解約時は status=canceled（または inactive）に変更

必要なら「最後の挨拶メール」を自動送信

7. 重要ポリシー（サポート）

口座変更（バインド解除）は原則 運営側で対応
（例：月1回まで、セキュリティのため）

デモ利用は原則「初回動作確認用」
要望が多ければ allow_demo を有料オプションとして開放

## 管理用ダウンロード発行

- 初回DL：
  /admin/confirm-payment
  管理画面からURLを発行し、手動でメール送信

- 再送：
  /admin/resend-download
  SendGridで自動送信

※ DLトークンは1回のみ有効
※ EA起動には購入メール＋WebRequest必須


① 管理画面にコピーボタン（UX）
navigator.clipboard.writeText(downloadUrl);

② トークン発行ログをDBに残す

（誰にいつ出したか追える）　　※のとこの会話チャット「返信メール」のとこの会話
さらに“保険”としてやるなら、この2つだけで十分

これは「すぐじゃなくて、余裕ができたら」でOK👇

/license/validate に簡単な秘密キーを追加

EA から x-ea-secret: すごく長いランダムな文字列 を一緒に送る

サーバー側でも同じ文字列を .env に持っておいてチェック

合わなければ即 NG

→ 「EA を持ってる人（正規利用者）」以外はこの API を自由に叩けなくなる。

レート制限（攻撃の連打を防ぐ）

express-rate-limit みたいなライブラリを使って

同じIPから 1分間に何十回も叩かれたら少し止める

→ 将来ユーザーが増えた時の“荒らし”に強くなる。


SQLに入れる
B. いま配るZIPを変えたいとき（v6に切替）
update app_settings
set value = 'Rakutore_Anchor_v6.zip', updated_at = now()
where key = 'ea_zip_path';

3) すぐ確認できるチェック

SQL Editorでこれ打つと「今どのZIPを配布設定にしてるか」見れます：

select * from app_settings where key='ea_zip_path';

