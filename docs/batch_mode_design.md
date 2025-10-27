# 一括QR生成 管理者ボタン設計書

## 1. 構成概要
- クライアント（既存の静的フロントエンド）に管理者ボタン起動のモーダルとバッチ実行ロジックを追加。
- バッチ処理は前段で QR 画像を生成→PNG化し、後段でバックエンド API を経由して Google Drive にアップロード。
- バックエンドはサービスアカウントを用いて Drive API にアクセスし、進捗レスポンスとログ記録を担う。

```
User
 └─(Admin button)─▶ Front-end Batch Orchestrator
                      ├─▶ QR Generator (現行 qrcode ライブラリ)
                      ├─▶ Upload Job Queue (max concurrency 3)
                      └─▶ Batch API Client
                                      └─▶ Backend /api/batch-upload
                                            ├─▶ Google Auth (Service Account)
                                            └─▶ Drive API (Files.create, Files.get)
```

## 2. フロントエンド設計

### 2.1 新規モジュール構成
- `src/batch/index.ts`
  - 管理者ボタントリガーとモーダル初期化を定義。
  - `initBatchMode(document)` を `main` 初期化時に呼び出す。
- `src/batch/BatchModal.ts`
  - モーダル UI の生成・状態管理。`open()`, `close()`, `setProgress()`, `setError()` などを提供。
  - コンポーネントは Tailwind クラスでスタイルを合わせる。DOM は `document.body` 末尾に `dialog` 要素として追加。
- `src/batch/catalog.ts`
  - `boothCatalog` 定数（`{ boothId, boothName }[]`）をエクスポート。
  - ビルド時に `scripts/buildBoothCatalog.ts` で `booths.csv` から生成する仕組みを整備。
- `src/batch/orchestrator.ts`
  - 実際の一括処理を管理。状態: `idle`, `running`, `paused`, `completed`.
  - `startBatch(options)` を外部に公開し、内部で `BatchRunner` を生成。
- `src/batch/runner.ts`
  - 逐次実行ロジック。`PromisePool` 構造を用意し、同時実行数を制御。
  - 各ジョブの成功/失敗イベントを発火し、モーダルに通知。
- `src/batch/uploader.ts`
  - API クライアント。`uploadBatch(items: UploadItem[])` で最大5件までまとめて送信。
  - API トークンは `X-Batch-Token` ヘッダーに格納（CSRF 回避で `meta` から取得）。
- `src/batch/filename.ts`
  - 屋台名を半角英数に整形するユーティリティ。全角記号は `_` に置換。

### 2.2 起動トリガー
- 画面右下に常時表示される管理者向けボタン（`#batch-trigger`）を追加。Tailwind ユーティリティで丸型フローティングボタン風にスタイル。
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
- 画像は `fetch(imageDataUrl).then(res => res.blob())` で `Blob` 化し、`File` コンストラクタに渡す。

### 2.4 進捗UI
- モーダルは以下の領域を持つ:
  - 概要ヘッダー（総件数、保存先）。
  - プログレスバー（`completed / total`）。
  - ステータスリスト（最新5件をスクロール可能リストで表示）。
  - フッターボタン（`キャンセル` / `失敗のみ再実行` / `閉じる`）。
- `BatchRunner` から `onProgress({ boothId, status, driveLink? })` イベントを受け取り DOM を更新。

### 2.5 エラーハンドリング
- `UploadItem` のアップロードで 429 => 1 秒間隔で最大 5 回リトライ（指数バックオフ）。
- 401/403 => 処理停止し、モーダルに「認証エラー (再ログインが必要です)」を表示。
- クライアント側で例外が投げられた場合、`BatchRunner` が失敗状態にして残件は待機。完了後に `失敗のみ再実行` が有効になる。

## 3. バックエンド設計

### 3.1 エンドポイント
- `POST /api/batch-upload`
  - 受信ボディ: `BatchUploadRequest`
    ```ts
    interface UploadItem {
      boothId: string;
      boothName: string;
      fileName: string;
      imageData: string; // data URL or Base64
    }
    interface BatchUploadRequest {
      items: UploadItem[];
      batchId: string; // クライアント生成の UUID
    }
    ```
  - レスポンス: `BatchUploadResponse`
    ```ts
    interface UploadResult {
      boothId: string;
      status: 'success' | 'failed';
      fileId?: string;
      webViewLink?: string;
      errorMessage?: string;
    }
    interface BatchUploadResponse {
      results: UploadResult[];
      folderLink?: string;
    }
    ```

### 3.2 認証フロー
- バックエンドは `.env` に格納したサービスアカウント JSON を使用して `google.auth.JWT` を初期化。
- フロントからのリクエストには `Authorization: Bearer <JWT>` で短期トークンを要求。
  - トークンは別途 `POST /api/batch-token` で発行し、`exp` 5 分。
  - トークン検証に失敗した場合は 401 を返す。

### 3.3 Drive API 呼び出し
- `drive.files.create` で PNG をアップロード。
  - `parents: [FOLDER_ID]`
  - `name: fileName`
  - `appProperties: { boothId, boothName, batchId }`
  - `fields: 'id, webViewLink'`
- 成功後、`results` に `fileId` `webViewLink` をセット。
- 同名ファイルが存在する場合は `files.list` で検索し、`appProperties.boothId` が一致したら `files.update` に切り替える。

### 3.4 ロギング
- `batchId` 単位でログを出力:
  - 開始: 件数、フォルダID。
  - 各写真: `boothId`, `status`, `fileId`.
  - 失敗: エラーメッセージ＋スタックトレース。
- 保存形式は Cloud Logging またはローカル JSONL (`logs/batch/<date>.jsonl` )。

## 4. データ管理
- `booth_catalog.json`（生成物）:
  ```json
  [
    { "boothId": "A01", "boothName": "GGクロッフル" },
    ...
  ]
  ```
- 生成スクリプト `scripts/buildBoothCatalog.ts`:
  - `booths.csv` を読み込み、英字＋整数をゼロ埋め。
  - JSON を `src/batch/catalog.json` として保存し、TypeScript で `import catalog from './catalog.json' assert { type: 'json' };` を使う。

## 5. シーケンス（正常系）
1. ユーザーが画面右下の「一括QR生成」ボタンを押下し、モーダルが開く。
2. `生成開始` ボタン押下で `BatchRunner.start()`。
3. カタログから先頭 3 件を `PromisePool` に投入。
4. 各ジョブで `generateQrData` を呼び出し、`imageDataUrl` を取得。
5. `uploadBatch` が 3 件をまとめて API へ送信。
6. バックエンドが Drive に `files.create` を実行し、結果を返す。
7. フロントは結果を受け取り、モーダル進捗を更新。
8. ジョブが完了したら次の未処理アイテムを投入。
9. 全件完了後に完了メッセージとフォルダリンクを表示。

## 6. エラーシーケンス（部分失敗）
1. アップロードのうち1件が Drive API 429 を返す。
2. バックエンドが `Retry-After` を尊重し、指数バックオフで再試行（最大5回）。
3. 再試行が尽きた場合、`status: failed`, `errorMessage` を返却。
4. フロントは該当ブースを `failed` 表示。`retryQueue` に追加。
5. ユーザーが `失敗のみ再実行` を押下 → `BatchRunner` が `retryQueue` を新たなバッチで処理。

## 7. テスト戦略
- **ユニットテスト**
  - `filename.ts`: マルチバイト・スペース変換テスト。
  - `catalog.ts`: カタログ件数と重複チェック。
  - `uploader.ts`: リクエスト分割（5件単位）の検証。
- **統合テスト**
  - モックサーバーを用いた `BatchRunner` の end-to-end。
  - Playwright で管理者ボタン押下→モーダル表示確認。
- **手動テスト**
  - Staging 環境でサービスアカウントに限定共有されたフォルダへアップロードし、UI 上の進捗を確認。

## 8. 移行計画
- バックエンドデプロイ（環境変数: `DRIVE_FOLDER_ID`, `GOOGLE_APPLICATION_CREDENTIALS`）。
- `booth_catalog.json` を生成し、コードと一緒にコミット。
- フロントエンドをデプロイし、キャッシュ無効化（`assets/main.js` のバージョン更新）。
- 運用マニュアル（管理者ボタンの位置・操作手順・エラー時の対処法）を wiki に追記。

## 9. リスクと緩和策
- **Drive API 認証破綻**: トークン期限切れに備え、早期リフレッシュ＋Slack 通知。
- **カタログ漏れ**: ビルド時に `booth_catalog.json` の件数が 117 件であることを CI で検査。
- **API レート制限**: フロントは 3 並列、バックエンドは指数バックオフでレート管理。
- **ユーザー誤操作**: モーダルに「実行中はページを閉じないでください」を明示し、閉じた場合の再実行方法を案内。
