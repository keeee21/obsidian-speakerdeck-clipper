# アーキテクチャ

## 処理の流れ

```
content.js          popup.js
─────────           ──────────────────────────────────────────────
DOM 解析      →     PDF を fetch（ArrayBuffer）
 ├ og:title         └ PDF.js で 1 ページずつ:
 ├ og:author              ① getTextContent() でテキスト抽出
 ├ .deck-date             ② 文字数 < しきい値（既定 20）なら
 ├ .deck-description         canvas にレンダリング → Tesseract.js で OCR
 └ a[title="Download PDF"]
                    → Markdown 生成 → PDF/.md 保存・クリップボード・obsidian:// 送出
```

Speaker Deck のスライドは画像のみの PDF であることが多く、その場合は ② の OCR が使われます。
テキストレイヤーを持つ PDF では OCR を通らないため、大幅に高速です。

## ファイル構成

```
manifest.json          Manifest V3 設定
popup/popup.html        ポップアップ UI（Obsidian Web Clipper 風）
popup/popup.css          スタイル（ライト / ダーク対応）
popup/popup.js           PDF 取得・テキスト抽出・OCR・Markdown 生成・出力
scripts/content.js       Speaker Deck の DOM 解析（executeScript で注入）
setup-libs.sh            lib/ にライブラリと学習済みデータを配置
lib/                      同梱ライブラリ（.gitignore 対象）
icons/                    拡張機能アイコン
```

## 権限

| 権限 | 用途 |
| --- | --- |
| `activeTab` / `tabs` / `scripting` | Speaker Deck のタブに `content.js` を注入してメタデータを取得 |
| `downloads` | PDF と `.md` の保存 |
| `clipboardWrite` | Markdown のクリップボードコピー |
| `storage` | 設定の保存 |
| `host_permissions: speakerdeck.com` | PDF の取得 |
| `optional_host_permissions: https://*/*` | PDF が別ホストに置かれていた場合のみ、実行時に許可を求める |

`content_security_policy` に `'wasm-unsafe-eval'` を指定しています（Tesseract.js の WASM 実行に必要）。

Manifest V3 は CDN からのスクリプト読み込み（リモートコード）を禁止しているため、
PDF.js / Tesseract.js 本体と OCR 用の学習済みデータはすべて拡張機能内（`lib/`）に同梱しています。
配置内容は [maintenance.md](maintenance.md) を参照してください。
