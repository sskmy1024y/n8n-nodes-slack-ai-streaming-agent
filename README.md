# n8n-nodes-slack-ai-streaming-agent

n8n の AI Agent ノードと同等のサブノード接続（Model / Tools / Memory）を持ちつつ、LLM のトークンストリーミングを Slack AI Apps のネイティブストリーミング API にリアルタイム中継するカスタムコミュニティノード。

## 特徴

- Slack AI Apps の `chat.startStream` / `chat.appendStream` / `chat.stopStream` によるリアルタイムストリーミング
- 「編集済み」マーク無しでの応答表示
- n8n 標準の LangChain サブノード（Model / Tools / Memory）をそのまま接続可能
- Tool 実行ステップを `task_update` チャンクで Slack UI に表示
- スロットリング・バッファリング・フォールバック（`chat.postMessage`）を内蔵
- フィードバックボタン（👍👎）対応

## 前提条件

- **n8n** v1.0 以上（セルフホスト）
- **Slack App** で **Agents & AI Apps** 機能が有効化されていること
- **Node.js** 18 以上

## インストール

### 方法 1: npm（推奨）

n8n の GUI からインストール:

1. **Settings** → **Community Nodes** → **Install a community node**
2. パッケージ名に `n8n-nodes-slack-ai-streaming-agent` を入力
3. **Install** をクリック

または CLI で:

```bash
# n8n のカスタムノードディレクトリに移動
cd ~/.n8n/custom

# インストール
npm install n8n-nodes-slack-ai-streaming-agent
```

### 方法 2: ソースからビルド（開発用）

```bash
git clone <repository-url> n8n-nodes-slack-ai-streaming-agent
cd n8n-nodes-slack-ai-streaming-agent
npm install
npm run build
```

ビルド後、n8n にリンク:

```bash
# グローバルリンク
npm link

# n8n のカスタムノードディレクトリでリンク
cd ~/.n8n/custom
npm link n8n-nodes-slack-ai-streaming-agent
```

### 方法 3: Docker（ボリュームマウント）

`docker-compose.yml` に以下を追加:

```yaml
services:
  n8n:
    image: n8nio/n8n
    volumes:
      - ./n8n-nodes-slack-ai-streaming-agent/dist:/home/node/.n8n/custom/node_modules/n8n-nodes-slack-ai-streaming-agent/dist
      - ./n8n-nodes-slack-ai-streaming-agent/package.json:/home/node/.n8n/custom/node_modules/n8n-nodes-slack-ai-streaming-agent/package.json
```

> **注意:** いずれの方法でもインストール後に **n8n の再起動** が必要です。

## Slack App のセットアップ

### 1. App の作成と設定

1. [Slack API](https://api.slack.com/apps) で新しい App を作成
2. **Features** → **Agents & AI Apps** をトグル ON
3. **OAuth & Permissions** で以下のスコープを追加:

| スコープ | 用途 |
|---|---|
| `chat:write` | メッセージ送信、ストリーミング |
| `assistant:write` | AI Apps 機能（ステータス、プロンプト、タイトル） |
| `im:history` | DM スレッドの会話履歴取得 |

### 2. イベントの購読

**Event Subscriptions** を有効にし、Request URL に n8n の Webhook URL を設定:

```
https://your-n8n-domain.example.com/webhook/slack-events
```

以下の Bot Events を購読:

- `assistant_thread_started`
- `assistant_thread_context_changed`
- `message.im`

### 3. App Manifest

テンプレートの [`slack-app-manifest.json`](slack-app-manifest.json) を使用できます。

1. `request_url` を実際の n8n Webhook URL に書き換え
2. [Slack API](https://api.slack.com/apps) → **App Manifests** に貼り付け

### 4. Bot Token の取得

**OAuth & Permissions** → **Install to Workspace** → 生成された **Bot User OAuth Token**（`xoxb-...`）をコピー。

## n8n での使い方

### 1. Credential の登録

n8n 標準の Slack credential をそのまま使用します。

1. **Credentials** → **New Credential** → **Slack API** を選択
2. **Access Token** フィールドに `xoxb-...` トークンを入力
3. **Save** → **Test** で接続確認

> 既存の Slack credential がある場合はそのまま選択できます。

### 2. ワークフローの構築

テンプレートの [`examples/slack-ai-agent-workflow.json`](examples/slack-ai-agent-workflow.json) を n8n にインポートすると、以下の構成がそのまま使えます。

> **インポート方法:** n8n の画面右上 **⋮** → **Import from File** → JSON ファイルを選択

#### 基本構成

```
[Webhook Trigger]
  │
  ├─ (event_type == "assistant_thread_started")
  │   └→ [HTTP Request] assistant.threads.setSuggestedPrompts
  │
  ├─ (event_type == "message.im")
  │   └→ [Slack AI Streaming Agent]
  │        ├── Model: OpenAI Chat Model (gpt-4o)
  │        ├── Tools: HTTP Request Tool, Code Tool 等
  │        └── Memory: Window Buffer Memory
  │
  └→ [後処理] ログ記録等
```

#### Webhook Trigger の設定

| 項目 | 値 |
|---|---|
| HTTP Method | POST |
| Path | `/slack-events` |
| Response Mode | **Immediately** |
| Response Code | 200 |

> **重要:** Slack Events API は 3 秒以内に 200 応答を要求します。Response Mode は必ず **Immediately** にしてください。

#### Slack AI Streaming Agent ノードの設定

| パラメータ | 設定例 | 説明 |
|---|---|---|
| Channel ID | `{{ $json.event.channel }}` | Slack イベントの channel フィールド |
| Thread TS | `{{ $json.event.thread_ts \|\| $json.event.ts }}` | スレッドのタイムスタンプ |
| Recipient User ID | `{{ $json.event.user }}` | メッセージ送信者のユーザー ID |
| Recipient Team ID | `{{ $json.team_id }}` | ワークスペース ID |
| Prompt Source | Take from Previous Node | 前ノードの `chatInput` を自動取得 |
| System Prompt | （任意） | AI の振る舞いを指定 |

#### Options（オプション設定）

| オプション | デフォルト | 説明 |
|---|---|---|
| Task Display Mode | `timeline` | Tool ステップの表示形式（`timeline`: 個別 / `plan`: グループ） |
| Max Iterations | `10` | Tool 呼び出しの最大反復回数 |
| Append Throttle (ms) | `100` | `appendStream` の最小送信間隔 |
| Feedback Buttons | `false` | 応答末尾に 👍👎 ボタンを表示 |
| Set Thread Title | `false` | ユーザーメッセージからスレッドタイトルを自動設定 |

### 3. サブノードの接続

#### Model（必須）

n8n 標準の LLM モデルノードを接続:

- OpenAI Chat Model
- Anthropic Chat Model
- Google Gemini Chat Model

#### Tools（任意）

n8n 標準の Tool ノードを接続:

- HTTP Request Tool
- Code Tool
- Calculator
- Wikipedia
- その他カスタム Tool

#### Memory（任意）

n8n 標準の Memory ノードを接続:

- Window Buffer Memory（推奨）
- Buffer Memory

### 4. 出力データ

ノードは以下の JSON を出力します:

```json
{
  "message_ts": "1724264405.531769",
  "channel": "D324567865",
  "thread_ts": "1724264400.000000",
  "response_text": "AI の完全な応答テキスト",
  "intermediate_steps": [
    {
      "toolName": "http_request",
      "toolCallId": "call_abc123",
      "args": { "url": "https://api.example.com/data" },
      "result": "..."
    }
  ],
  "token_count": 342,
  "duration_ms": 4520
}
```

## 開発

```bash
# 依存パッケージのインストール
npm install

# ビルド
npm run build

# 型チェック
npm run lint

# テスト
npm test

# 開発モード（ファイル変更を監視）
npm run dev
```

### テスト

```bash
# 全テスト実行
npm test

# カバレッジ付き
npx jest --coverage
```

## 制約事項

- ストリーミングは **スレッド内でのみ** 動作します（DM は全てスレッドとして扱われます）
- ストリーミング中は Block Kit を使用できません（`stopStream` 時のみ可能）
- ストリーミング中の unfurl は無効化されます
- Workspace ゲストは Agents & AI Apps 機能にアクセスできません
- Slack AI Apps 機能は有料プランが必要です（[Developer Program](https://api.slack.com/developer-program) で無料サンドボックス利用可）

## ライセンス

MIT
