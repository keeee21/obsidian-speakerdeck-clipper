# アーキテクチャ

## 処理の流れ

```
content.js          popup.js
─────────           ──────────────────────────────────────────────
DOM 解析      →     テンプレートを変数で展開（ノート名・保存先・プロパティ）
 ├ og:title          ↓
 ├ og:author        PDF を fetch（ArrayBuffer）
 ├ .deck-date        └ PDF.js で 1 ページずつ:
 ├ .deck-description       ① getTextContent() でテキスト抽出
 └ a[title="Download PDF"]  ② 文字数 < しきい値（既定 20）なら
                                canvas にレンダリング → Tesseract.js で OCR
                     ↓
                    {{slides}} を組み立ててノート本文を生成
                     ↓
                    フロントマター + 本文 → Vault へ直接書き込み
                                          / ダウンロード + obsidian:// 送出
```

Speaker Deck のスライドは画像のみの PDF であることが多く、その場合は ② の OCR が使われます。
テキストレイヤーを持つ PDF では OCR を通らないため、大幅に高速です。

## ファイル構成

```
manifest.json           Manifest V3 設定
settings.html           設定画面（chrome-extension://<id>/settings.html）
settings/settings.js     設定画面のロジック（セクション切り替え・テンプレート編集）
settings/settings.css    設定画面のレイアウト
popup/popup.html         ポップアップ（保存操作のみ。設定項目は持たない）
popup/popup.js           メタデータ取得・PDF 取得・OCR・本文生成・保存
popup/popup.css          ポップアップのレイアウト
src/store.js             設定 / テンプレート / プロパティ型の永続化と移行
src/template.js          {{変数|フィルタ}} の展開とフロントマター生成
src/icons.js             同梱アイコン（SVG パス）
src/style.css            設定画面とポップアップで共有するデザインシステム
scripts/content.js       Speaker Deck の DOM 解析（executeScript で注入）
setup-libs.sh            lib/ にライブラリと学習済みデータを配置
lib/                      同梱ライブラリ（.gitignore 対象）
icons/                    拡張機能アイコン
```

`settings.html` と `popup/popup.html` は独立したページですが、`src/` の 4 つを共有します。
`popup.js` は設定値を読むだけで書き換えません。設定の変更経路を設定画面 1 か所に絞ることで、
両方の画面が同じ設定を別々に書き戻して壊れる状態を避けています。

## データモデル

`chrome.storage.local` に 2 つのキーで保存します。

```
settings   拡張全体の設定 + propertyTypes（プロパティ名 → 型 / 既定値）
templates  テンプレートの配列
```

`storage.sync` を使っていないのは、1 項目あたり 8KB の制限があり、
ノート本文フォーマットを含むテンプレートが収まらないためです。

Vault のディレクトリハンドル（`FileSystemDirectoryHandle`）だけは
構造化複製オブジェクトのため `chrome.storage` に入らず、IndexedDB に置いています。

旧形式（設定 1 個だけを持つフラットな構造）の設定が残っている場合は、
`src/store.js` の読み込み時にテンプレート 1 個へ変換して保存し直します。

## 権限

| 権限 | 用途 |
| --- | --- |
| `activeTab` / `tabs` / `scripting` | Speaker Deck のタブに `content.js` を注入してメタデータを取得 |
| `downloads` | PDF・画像・`.md` の保存（ダウンロード方式のとき） |
| `clipboardWrite` | Markdown のクリップボードコピー |
| `storage` | 設定とテンプレートの保存 |
| `host_permissions: speakerdeck.com` | PDF の取得 |
| `optional_host_permissions: https://*/*` | PDF が別ホストに置かれていた場合のみ、実行時に許可を求める |

`content_security_policy` に `'wasm-unsafe-eval'` を指定しています（Tesseract.js の WASM 実行に必要）。

Manifest V3 は CDN からのスクリプト読み込み（リモートコード）を禁止しているため、
PDF.js / Tesseract.js 本体と OCR 用の学習済みデータ、UI のアイコンはすべて拡張機能内に同梱しています。
配置内容は [maintenance.md](maintenance.md) を参照してください。
