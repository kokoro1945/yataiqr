# 一括QR生成 管理者ボタン設計書

## 1. 構成概要
- クライアント（既存の静的フロントエンド）に管理者ボタン起動のモーダルとバッチ実行ロジックを追加。
- バッチ処理はブラウザ内で QR 画像を生成し、その場で ZIP にまとめてダウンロードさせる。バックエンド依存はない。

```
User
 └─(Admin button)─▶ Front-end Batch Orchestrator
                      ├─▶ QR Generator (既存 window.YataiQRBatch.generateQrData)
                      ├─▶ Catalog Loader (booth_catalog.json)
                      └─▶ ZIP Builder (JSZip)
                                   └─▶ Download Link (Blob URL)
```

## 2. フロントエンド設計

### 2.1 モジュール構成
- `assets/batch-mode.js`
  - 管理者ボタンのイベント登録、モーダル生成、バッチ処理本体、ZIP ダウンロードリンク生成までを担当。
  - `window.YataiQRBatch.generateQrData` を利用して既存の QR 生成ロジックを再利用。
- `assets/booth_catalog.json`
  - バッチ対象の屋台番号・屋台名リスト。`scripts/build-booth-catalog.js` で `booths.csv` から生成。
- 外部ライブラリ
  - `qrcode`: 既存バンドルに含まれる QR 生成ライブラリ。
  - `JSZip`: CDN から読み込み、ブラウザで ZIP を生成。
- `index.html`
  - 管理者用ボタンと JSZip の読み込みスクリプトタグを追加。

### 2.2 起動トリガー
- ページ上部の操作パネルに管理者向けボタン（`#batch-trigger`）を追加。既存フォームと同列に配置し、ラベルやバッジで運営専用であることを明示。
- ボタン押下で `openModal()` を呼び出し、一括処理モーダルを表示。
- モーダル内で `閉じる` した際はフォーカスをトリガーボタンへ戻してアクセシビリティを担保。

### 2.3 QR 生成のバッチ化
- 既存の `renderQR` はキャンバス描画のため非同期 `Promise`.
- バッチ用に `generateQrData(boothId, boothName, size)` を新設し、`qrcode` ライブラリへ直接アクセスできるよう現行モジュールを切り出す。
- `generateQrData` 返却値:
  ```ts
  interface GeneratedQr {
    boothId: string;
    boothName: string;
    label: string;
    imageDataUrl: string; // data:image/png;base64,xxx
  }
  ```
- 画像は data URL から base64 部分を抽出し、JSZip の `file` メソッドに `{ base64: true }` で追加する。Blob 化は不要。

### 2.4 進捗UI
- モーダルは以下の領域を持つ:
  - 概要ヘッダー（総件数、出力形式）。
  - プログレスバー（`completed / total`）。
  - ステータスリスト（最新5件をスクロール可能リストで表示）。
  - フッターボタン（`ZIPをダウンロード` / `生成開始` / `再実行` / `処理を中断` / `閉じる`）。
- ログリストには「待機中 → 生成中 → 成功/失敗」のステータスを表示し、成功時は「ZIPへ追加済み」とする。

### 2.5 エラーハンドリング
- QR 生成に失敗した場合は対象屋台を `failures` 配列に記録し、処理を継続。
- `キャンセル` 押下時は `state.aborted = true` にして現在処理中のループを抜ける。成功分が存在する場合は部分的な ZIP を提供する。
- ZIP 生成（`generateAsync`）で例外が発生した場合は Blob URL を作成せず、警告ダイアログを表示して再実行を促す。

## 3. ZIP 生成設計
- **ライブラリ読み込み**: CDN から `jszip.min.js` を `<script>` で読み込み、`window.JSZip` として利用。
- **インスタンス管理**: バッチ開始時に `state.zip = new JSZip()` を生成し、完了時に `generateAsync({ type: 'blob' })` で Blob を取得。
- **ファイル名規則**: `createFileName` で屋台名を半角英数字にサニタイズ、`buildZipFileName` で時刻＋件数を含めた ZIP 名を構築。
- **ダウンロードリンク**: Blob から生成した Object URL を `a[data-download]` に設定し、ユーザー操作でファイル保存。完了後は `URL.revokeObjectURL` を実行してリークを防止。

## 4. データ管理
- `booth_catalog.json`（生成物）:
  ```json
  [
    { "boothId": "A01", "boothName": "GGクロッフル" },
    ...
  ]
  ```
- 生成スクリプト `scripts/build-booth-catalog.js`:
  - `booths.csv` を読み込み、英字＋整数をゼロ埋め。
  - JSON を `assets/booth_catalog.json` として保存し、フロントエンドから `fetch('./assets/booth_catalog.json')` で参照する。

## 5. シーケンス（正常系）
1. ユーザーがページ上部の「一括QR生成」ボタンを押下し、モーダルが開く。
2. `生成開始` ボタン押下で `startBatch()` が呼ばれ、`state.zip = new JSZip()` を準備。
3. カタログを読み込み、件数表示・ログリストを初期化。
4. 各屋台について `generateQrData` で data URL を取得し、`createFileName` で命名して JSZip に追加。
5. 成功した屋台は「成功 / ZIPへ追加済み」と表示、失敗した屋台は `failures` に蓄積して「失敗」と表示。
6. 全件処理後に `generateAsync({ type: 'blob' })` で ZIP を生成し、ダウンロードリンクを活性化。
7. 完了状態に応じて「完了」または「一部失敗」を表示し、必要に応じて `再実行` ボタンを表示。

## 6. エラーシーケンス（部分失敗）
1. `generateQrData` が例外を投げる（無効な屋台名など）。
2. 当該屋台を `failures` に追加し、ログで「失敗（QR生成に失敗しました）」を表示。
3. 残りの屋台処理を継続。
4. 完了後、モーダルが「一部失敗」と表示し、`再実行` ボタンが活性化。
5. ユーザーが `再実行` を押下 → 全件を再度生成し、ZIP を作り直す。

## 7. テスト戦略
- **ユニットテスト**
  - `sanitizeFileName` や `buildZipFileName` のフォーマット検証。
  - `extractBase64` の分岐テスト。
- **統合テスト**
  - Playwright 等でボタン押下→モーダル表示→ZIP ダウンロード成功を確認。
- **手動テスト**
  - Mac/Windows の主要ブラウザで ZIP が正しく解凍できるか確認。

## 8. 移行計画
- `npm run build:catalog` で最新の屋台カタログ JSON を生成し、リポジトリにコミット。
- `index.html` へ JSZip の `<script>` を追加したため、キャッシュバスティングを考慮してデプロイする。
- 本番反映後、管理者ボタンの動作確認と ZIP ダウンロードが成功するかを手動テスト。
- 運用マニュアル（管理者ボタンの位置・操作手順・失敗時の再実行方法）を wiki に追記。

## 9. リスクと緩和策
- **ブラウザ互換性**: JSZip がサポートするモダンブラウザでテストし、サポート対象を明記。
- **大容量メモリ消費**: 一度に 100 件以上の PNG を保持するため、処理中は他タブを閉じるよう案内。必要ならサイズオプションを追加検討。
- **ユーザー誤操作**: モーダルで「処理中はページを閉じない」旨を明示し、中断しても再実行できる設計にする。
- **カタログの不整合**: `booth_catalog.json` と `booths.csv` の件数チェックを CI に組み込み、更新漏れを防ぐ。
