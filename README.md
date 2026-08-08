# Speaker Deck → Obsidian

Speaker Deck のスライドを文字起こしして Obsidian に保存する Chrome 拡張機能（Manifest V3）です。
生成 AI は使わず、PDF 取得から OCR・Markdown 生成まですべてブラウザローカルで処理します。外部 API への送信はありません。

詳しい仕様・アーキテクチャ・メンテナンス方針は [docs/](docs/) を参照してください。

---

## セットアップ

```bash
git clone <this repo>
cd obsidian-speaker-deck
./setup-libs.sh          # PDF.js / Tesseract.js / 学習済みデータを lib/ に配置（約 25MB）
```

続いて Chrome に読み込みます。

1. `chrome://extensions` を開く
2. 右上の「デベロッパー モード」を ON
3. 「パッケージ化されていない拡張機能を読み込む」→ このディレクトリを選択

> `setup-libs.sh` が何を配置するか、学習済みデータの版を変える方法は
> [docs/maintenance.md](docs/maintenance.md) を参照してください。

---

## 使い方

1. Speaker Deck のスライドページ（`https://speakerdeck.com/{user}/{slug}`）を開く
2. ツールバーの拡張機能アイコンをクリック
3. 保存先（Vault / ノート名 / 保存先パス / PDF 保存先）とプロパティを確認・編集
4. **「スライドを解析」** → PDF を取得してページごとに文字起こし
5. プレビューを確認して **「Obsidian に追加」**

> **長いスライドの場合**: ポップアップは画面外をクリックすると閉じ、処理も中断されます。
> ヘッダーの **⧉** ボタンでタブとして開き直すと、OCR が長時間かかるスライドでも中断されません。

### ポップアップ UI（Obsidian Web Clipper 準拠）

| 項目 | 説明 |
| --- | --- |
| **出力方式** | `Vault に直接書き込み`（既定）/ `ダウンロード + obsidian:// URI` |
| **Vault フォルダ** | 直接書き込み時の書き込み先。初回だけ「選択…」で Vault のルートを指定 |
| **Vault 名** | URI 方式のときの送出先 Vault 名。フォルダ名と同じ文字列（例 `MyVault`）。空欄なら Obsidian の既定 Vault |
| **ノート名** | 作成するノート名。PDF のファイル名もこれに揃えます |
| **ノート保存先** | ノートを置く Vault 内のパス。直接書き込みなら**無ければ自動作成** |
| **PDF 保存先** | PDF を置くパス。直接書き込みなら Vault 内（空欄でノートと同じ場所） |
| **プロパティ** | フロントマターに入る `title` / `author` / `source` / `date` / `tags` / PDF URL。その場で編集可能 |
| **ノート内容** | 生成された Markdown。送出前に直接編集できます |
| **⚙ 設定** | OCR の有無・しきい値・言語・レンダリング幅・最大ページ数、Obsidian 連携方式、出力先の ON/OFF |

設定項目の詳細（既定値・意味）は [docs/features.md](docs/features.md#設定項目) を参照してください。

### 出力方式について

- **Vault に直接書き込み**（既定・推奨）: 初回だけ「Vault フォルダ」の「選択…」から Vault のルートを指定してください。以降は選び直し不要です。
- **ダウンロード + `obsidian://` URI**: File System Access を使いたくない場合の従来方式。PDF はダウンロードフォルダ経由になります。

それぞれの仕組みと制約は [docs/features.md](docs/features.md#出力方式) を参照してください。

---

## 既知の制限

- ポップアップのまま操作すると、画面外クリックで処理が中断されます（⧉ でタブ表示に切り替えてください）
- OCR は 1 ページあたり数秒かかります。100 ページ級のスライドは相応の時間が必要です
- 非公開・限定公開のスライドは PDF の直接ダウンロードが提供されない場合があります

その他の制限・動作確認環境は [docs/maintenance.md](docs/maintenance.md) を参照してください。
# obsidian-speakerdeck-clipper
