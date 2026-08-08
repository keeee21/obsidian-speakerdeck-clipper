#!/usr/bin/env bash
#
# lib/ にローカル実行用のライブラリ一式を配置する。
# Manifest V3 は CDN からのスクリプト読み込み（リモートコード）を禁止しているため、
# PDF.js / Tesseract.js / OCR 用の言語データはすべて拡張機能内に同梱する必要がある。
#
#   ./setup-libs.sh
#
set -euo pipefail

cd "$(dirname "$0")"

PDFJS_VERSION="3.11.174"          # UMD ビルド（pdf.js / pdf.worker.js）が入る最後の系列
TESSERACT_VERSION="5.1.1"
TESSERACT_CORE_VERSION="5.1.0"
# 学習済みデータの版。
#   4.0.0_fast … LSTM 専用・軽量（jpn 1.5MB）。既定。
#   4.0.0_best … より高精度だが 12MB & 低速。
#   4.0.0      … legacy + LSTM の混在版。26MB と最も重い。
#
# どの版も内部に legacy エンジン用パラメータ定義を含んでおり、tesseract.js の
# デフォルト（LSTM 専用 WASM コア）と組み合わせると起動のたびに
# "Parameter not found: language_model_ngram_on" 等の警告が出る。これは
# tessdata 側ではなく popup.js 側で Tesseract.createWorker(..., { legacyCore: true })
# を指定し combined WASM コアを使うことで解消している（OEM=1 なので認識自体は LSTM のみ）。
TESSDATA_VARIANT="${TESSDATA_VARIANT:-4.0.0_fast}"

UNPKG="https://unpkg.com"
TESSDATA="https://tessdata.projectnaptha.com/${TESSDATA_VARIANT}"

mkdir -p lib/tesseract/lang lib/cmaps lib/standard_fonts

fetch() { # fetch <url> <dest>
  local url="$1" dest="$2"
  if [ -s "$dest" ]; then
    echo "  skip  $dest (既に存在)"
    return
  fi
  echo "  get   $dest"
  curl -fsSL "$url" -o "$dest"
}

echo "==> PDF.js ${PDFJS_VERSION}"
fetch "${UNPKG}/pdfjs-dist@${PDFJS_VERSION}/legacy/build/pdf.js"        lib/pdf.js
fetch "${UNPKG}/pdfjs-dist@${PDFJS_VERSION}/legacy/build/pdf.worker.js" lib/pdf.worker.js

echo "==> PDF.js CJK cmaps（日本語 PDF のテキスト抽出に必須）"
if [ -z "$(ls -A lib/cmaps 2>/dev/null)" ]; then
  tmp="$(mktemp -d)"
  curl -fsSL "https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-${PDFJS_VERSION}.tgz" -o "${tmp}/pdfjs.tgz"
  tar -xzf "${tmp}/pdfjs.tgz" -C "${tmp}"
  cp -R "${tmp}/package/cmaps/." lib/cmaps/
  cp -R "${tmp}/package/standard_fonts/." lib/standard_fonts/
  rm -rf "${tmp}"
  echo "  ok    lib/cmaps, lib/standard_fonts"
else
  echo "  skip  lib/cmaps (既に存在)"
fi

echo "==> Tesseract.js ${TESSERACT_VERSION}"
fetch "${UNPKG}/tesseract.js@${TESSERACT_VERSION}/dist/tesseract.min.js" lib/tesseract.min.js
fetch "${UNPKG}/tesseract.js@${TESSERACT_VERSION}/dist/worker.min.js"    lib/tesseract/worker.min.js

echo "==> tesseract.js-core ${TESSERACT_CORE_VERSION}（WASM）"
for f in tesseract-core.wasm.js tesseract-core-simd.wasm.js \
         tesseract-core-lstm.wasm.js tesseract-core-simd-lstm.wasm.js; do
  fetch "${UNPKG}/tesseract.js-core@${TESSERACT_CORE_VERSION}/${f}" "lib/tesseract/${f}"
done

echo "==> 学習済みデータ (tessdata ${TESSDATA_VARIANT})"
fetch "${TESSDATA}/jpn.traineddata.gz" lib/tesseract/lang/jpn.traineddata.gz
fetch "${TESSDATA}/eng.traineddata.gz" lib/tesseract/lang/eng.traineddata.gz

echo
echo "完了。chrome://extensions で「パッケージ化されていない拡張機能を読み込む」から"
echo "$(pwd) を選択してください。"
