# メンテナンス方針

## `setup-libs.sh` が配置するもの

Manifest V3 は CDN からのスクリプト読み込み（リモートコード）を禁止しているため、
ライブラリと OCR 用の学習済みデータはすべて拡張機能内に同梱する必要があります。

| パス | 内容 |
| --- | --- |
| `lib/pdf.js`, `lib/pdf.worker.js` | PDF.js 3.11.174（UMD ビルド） |
| `lib/cmaps/`, `lib/standard_fonts/` | CJK CMap / 標準フォント（**日本語 PDF のテキスト抽出に必須**） |
| `lib/tesseract.min.js`, `lib/tesseract/worker.min.js` | Tesseract.js 5.1.1 |
| `lib/tesseract/tesseract-core*.wasm.js` | OCR エンジン本体（WASM） |
| `lib/tesseract/lang/{jpn,eng}.traineddata.gz` | 日本語 / 英語の学習済みデータ（`4.0.0_fast`） |

バージョンを上げる場合は `setup-libs.sh` 冒頭の `PDFJS_VERSION` / `TESSERACT_VERSION` / `TESSERACT_CORE_VERSION` を書き換えてから、
`lib/` を空にして再実行してください（`fetch()` は既存ファイルをスキップするため）。

## 学習済みデータの版を変える

既定は **`4.0.0_fast`**（LSTM 専用・jpn 1.5MB）です。より高精度な `4.0.0_best` に切り替えたい場合:

```bash
rm -f lib/tesseract/lang/*.traineddata.gz
TESSDATA_VARIANT=4.0.0_best ./setup-libs.sh
```

## Tesseract の "Parameter not found" 警告について

`4.0.0_fast` を含むどの版の tessdata も、内部に legacy エンジン用パラメータ定義
（`language_model_ngram_on` など）を含んでいます。tesseract.js は OEM 1（LSTM 専用）で動かす際、
デフォルトだと legacy モジュールを持たない LSTM 専用 WASM コアを選ぶため、
このパラメータ群を毎回 `SetVariable` しようとして

```
Warning: Parameter not found: language_model_ngram_on
```

のような警告がコンソールに出ます（tessdata 側の版を変えても解消しません）。

`popup.js` の `Tesseract.createWorker` に `legacyCore: true` を指定し、
legacy エンジンも含む combined WASM コア（`tesseract-core-simd.wasm.js`）を読み込むことで、
パラメータが正しく登録され警告が出なくなります。OCR 自体は引き続き OEM 1（LSTM 専用）で動くため、
認識結果や速度への影響はありません。**この設定を外さないでください。**

## 既知の制限

- ポップアップのまま操作すると、画面外クリックで処理が中断されます（⧉ でタブ表示に切り替えてください）
- OCR は 1 ページあたり数秒かかります。100 ページ級のスライドは相応の時間が必要です
- 非公開・限定公開のスライドは PDF の直接ダウンロードが提供されない場合があります
- `chrome.downloads` の制約により、Vault への直接保存には `README.md` 記載の設定が必要です

## 動作確認済み

- Chrome 116+ / macOS
- PDF.js 3.11.174（CJK CMap 込み）でのテキスト抽出（日本語 PDF 確認済み）
- Tesseract.js 5.1.1 + `jpn+eng` traineddata によるローカル OCR（日本語・英語の認識を確認）
- `legacyCore: true`（combined WASM コア）で `language_model_ngram_on` 等の警告が出ないことを確認
