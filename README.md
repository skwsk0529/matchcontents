# TimeQL Advice Bot

TimeQL API の返却内容だけを使って、`今日の自分向け助言` と `二人の相性` を返す最小チャットアプリです。

## 仕様

- 入力:
  - 今日の自分向け助言: `YYYYMMDD` の生年月日、`HH:mm` の出生時刻、出生地
  - 二人の相性: 2人分の生年月日、出生時刻、出生地
- 利用 API:
  - `POST /api/v1/transits`
  - `POST /api/v1/sukuyo/fortune`
  - `POST /api/v1/kyusei`
  - `POST /api/v1/qimen`
  - `POST /api/v1/synastry`
  - `POST /api/v1/sukuyo/compatibility`
  - `POST /api/v1/kyusei/compatibility`
- 出力:
  - TimeQL の返却事実を要約
  - その事実に基づく短い日次アドバイス
  - その事実に基づく短い相性コメント
- 制約:
  - 外部LLMは使わず、TimeQL の取得結果だけで文面を構成

## セットアップ

1. `.env.example` を `.env` にコピー
2. `TIMEQL_API_KEY` を設定
3. 起動

```bash
npm start
```

4. ブラウザで `http://localhost:3000`

## 公開

`Render` でそのまま公開できます。

1. GitHub にこのディレクトリを push
2. Render で `New +` → `Web Service`
3. リポジトリを選択
4. `render.yaml` を使ってデプロイ
5. Render 側の Environment で `TIMEQL_API_KEY` を設定

公開版には以下を入れています。

- `/health` ヘルスチェック
- 1 IP あたり毎分 10 リクエストの簡易レート制限
- `TIMEQL` の生レスポンスをブラウザへ返さない構成

## 注意

- 12桁入力だけでは TimeQL の主要エンドポイントに必要な出生地が不足します。
- 最小版では出生地をUIで受け取ります。必要なら位置情報推定や都道府県選択UIを追加できます。
- アドバイス文はサーバー側テンプレートで生成しているため、より会話的な体験にするなら返答履歴管理や複数ターン対応を追加してください。
