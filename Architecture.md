# n8n Custom Node 設計ドキュメント: Slack AI Streaming Agent

## 概要

n8n の AI Agent ノードと同等のサブノード接続（Model / Tools / Memory）を持ちつつ、LLM のトークンストリーミングを Slack の AI Apps ネイティブストリーミング API（`chat.startStream` / `chat.appendStream` / `chat.stopStream`）にリアルタイムで中継するカスタムコミュニティノードを開発する。

### 解決する課題

現在の n8n + Slack 構成では、bot の応答に「編集済み」が表示される。これは以下のフローに起因する：

1. `chat.postMessage` で仮メッセージ（「考え中...」等）を送信
2. LLM の応答完了を待つ
3. `chat.update` でメッセージを書き換える → **「編集済み」が付与される**

Slack AI Apps のストリーミング API を使えば、最初からストリーミングメッセージとして扱われるため「編集済み」は付かず、トークン単位のリアルタイム表示が実現できる。

### なぜ n8n 標準のストリーミングでは対応できないか

n8n の AI Agent ノードが持つストリーミング機能は **Webhook/Chat Trigger への SSE（Server-Sent Events）レスポンス**として設計されている。一方、Slack AI Apps のストリーミングは **Slack Web API への HTTP POST を3段階で呼び分ける**仕組みであり、プロトコルレベルで異なる。n8n 内部でこの変換を行うブリッジ機構は存在しないため、カスタムノードが必要となる。

| 比較項目 | n8n Streaming | Slack AI Apps Streaming |
|---|---|---|
| プロトコル | SSE（text/event-stream） | HTTP POST × 3 種類 |
| 方向 | Webhook caller へのレスポンス | アプリ → Slack API への能動的呼び出し |
| 制御 | Trigger ノードの Response Mode | `startStream` / `appendStream` / `stopStream` |
| 対応ノード | Chat Trigger, Webhook | なし（カスタム実装が必要） |

---

## アーキテクチャ

### ワークフロー全体像

```
Slack Event (Webhook Trigger: message.im / assistant_thread_started)
  │
  ├→ [前処理ノード群] スレッド情報取得、コンテキスト構築等
  │
  ├→ [Slack AI Streaming Agent]  ← 本ノード
  │     ├── 🤖 AI Model (LLM sub-node)
  │     ├── 🔧 Tools (Tool sub-nodes)
  │     └── 🧠 Memory (Memory sub-node)
  │
  │   内部処理:
  │     1. assistant.threads.setStatus("thinking...")
  │     2. Memory からチャット履歴取得
  │     3. streamText() で LLM ストリーミング呼び出し
  │     4. 最初のチャンク → chat.startStream
  │     5. 後続チャンク   → chat.appendStream (デルタ、スロットリング)
  │     6. Tool 呼び出し  → task_update チャンクでステップ表示
  │     7. 完了           → chat.stopStream (+ feedback blocks)
  │     8. Memory に会話保存
  │
  └→ [後処理ノード群] ログ記録、通知等
```

### Slack AI Apps イベントフロー

本ノードが対応する Slack 側のイベント・API フローは以下の通り：

```
User opens split pane
  → assistant_thread_started event
  → App: setSuggestedPrompts / say("How can I help?")

User sends message or clicks prompt
  → message.im event
  → App: setStatus("thinking...")
  → App: chat.startStream (ストリーム開始)
  → App: chat.appendStream × N (チャンク追加)
  → App: chat.stopStream (完了 + blocks)
```

参照: [Developing apps with AI features](https://docs.slack.dev/ai/developing-ai-apps/) / [AI in Slack apps overview](https://docs.slack.dev/ai/)

---

## ノード仕様

### ノード定義

```
パッケージ名: n8n-nodes-slack-ai-streaming-agent
ノード名: Slack AI Streaming Agent
ノードタイプ: n8n-nodes-slack-ai-streaming-agent.slackAiStreamingAgent
カテゴリ: AI
```

### パラメータ

| パラメータ | 型 | 必須 | 説明 |
|---|---|---|---|
| Slack Credential | credential | ✅ | Bot Token (`xoxb-`) |
| Channel ID | string (expression) | ✅ | DM チャンネル ID（イベントの `channel` フィールド） |
| Thread TS | string (expression) | ✅ | スレッドのタイムスタンプ |
| Recipient User ID | string (expression) | ✅ | ストリーム受信ユーザー（未ドキュメントだが必須） |
| Recipient Team ID | string (expression) | ✅ | ワークスペース ID（未ドキュメントだが必須） |
| Prompt Source | options | ✅ | "Take from previous node" / "Define below" |
| Prompt | string | 条件付き | Prompt Source が "Define below" の場合 |
| System Prompt | string | | システムプロンプト |
| Task Display Mode | options | | `timeline`（個別表示）/ `plan`（まとめて表示） |
| Max Iterations | number | | Tool 呼び出しの最大反復回数（デフォルト: 10） |
| Append Throttle (ms) | number | | appendStream の最小間隔（デフォルト: 100ms） |
| Feedback Buttons | boolean | | 応答末尾に 👍👎 ボタンを付与 |
| Set Thread Title | boolean | | 最初のユーザーメッセージからタイトルを自動設定 |

### サブノード接続（Inputs）

| 接続タイプ | 必須 | 説明 |
|---|---|---|
| `ai_languageModel` | ✅ | LLM（OpenAI, Anthropic 等の n8n 標準 Model ノード） |
| `ai_tool` | | ツール群（HTTP Request Tool, Code Tool 等） |
| `ai_memory` | | メモリ（Window Buffer Memory 等） |
| Main Input | ✅ | 前ノードからのデータ（chatInput を含む） |

### 出力

```json
{
  "message_ts": "1724264405.531769",
  "channel": "D324567865",
  "thread_ts": "1724264400.000000",
  "response_text": "完全な応答テキスト",
  "intermediate_steps": [...],
  "token_count": 342,
  "duration_ms": 4520
}
```

---

## 技術選定

### AI SDK: Vercel AI SDK（`ai` パッケージ）

LangChain ではなく Vercel AI SDK を採用する。

**理由:**

1. `streamText()` がトークン単位の async イテレータを返すため、Slack `appendStream` と直接接続できる
2. `n8n-nodes-better-ai-agent` が同じ AI SDK でサブノード接続の実装パターンを証明済み
3. LangChain の n8n 内部 API に依存しないため、n8n バージョンアップで壊れにくい
4. Tool 呼び出しの `onStepFinish` コールバックでステップ完了を検知し、Slack の task_update に変換可能

**主要依存パッケージ:**

```json
{
  "ai": "^4.x",
  "@ai-sdk/openai": "^1.x",
  "@ai-sdk/anthropic": "^1.x",
  "@ai-sdk/google": "^1.x",
  "@slack/web-api": "^7.x"
}
```

### 参考実装

| リポジトリ / リソース | 参考にする部分 |
|---|---|
| [n8n-nodes-better-ai-agent](https://github.com/fjrdomingues/n8n-nodes-better-ai-agent) | サブノード接続（Model/Tools/Memory）、Vercel AI SDK 統合パターン |
| [OpenClaw Issue #4391](https://github.com/openclaw/openclaw/issues/4391) | Slack chat.startStream/appendStream/stopStream の実装詳細、スロットリング、フォールバック |
| [n8n-nodes-starter](https://github.com/n8n-io/n8n-nodes-starter) | カスタムノードのスキャフォールディング |
| [n8n ToolsAgent V2 execute.ts](https://github.com/n8n-io/n8n/blob/master/packages/%40n8n/nodes-langchain/nodes/agents/Agent/agents/ToolsAgent/V2/execute.ts) | n8n 公式 Agent のストリーミング実装（参考のみ） |
| [n8n PR #18924](https://github.com/n8n-io/n8n/pull/18924) | SSE streaming format の追加 PR（n8n のストリーミング内部構造の理解） |
| [n8n PR #20499](https://github.com/n8n-io/n8n/pull/20499) | AI Agent の SSE streaming + tool call チャンク化（内部アーキテクチャ理解） |
| [n8n-nodes-streaming-ai-agent](https://github.com/jasonrlee6/n8n-node-ai-agent-with-streaming) | AG-UI プロトコルでの非同期ストリーミング配信パターン |

---

## Slack Streaming API 実装詳細

### API メソッド

参照: [chat.startStream](https://docs.slack.dev/reference/methods/chat.startStream) / [chat.appendStream](https://docs.slack.dev/reference/methods/chat.appendStream) / [chat.stopStream](https://docs.slack.dev/reference/methods/chat.stopStream)

#### 必要なスコープ

- `chat:write` — ストリーミングメッセージの送信
- `assistant:write` — AI Apps 機能（setStatus, setSuggestedPrompts, setTitle）

#### startStream

```typescript
const response = await client.chat.startStream({
  channel,
  thread_ts: threadTs,           // 必須: スレッド内のみ動作
  recipient_team_id: teamId,     // 必須（未ドキュメント）
  recipient_user_id: userId,     // 必須（未ドキュメント）
  task_display_mode: 'plan',     // optional: 'timeline' | 'plan'
  chunks: [
    {
      type: 'markdown_text',
      markdown_text: firstChunk,
    },
  ],
});
const streamTs = response.ts;    // 後続の append/stop で使用
```

#### appendStream

```typescript
await client.chat.appendStream({
  channel,
  message_ts: streamTs,
  thread_ts: threadTs,
  chunks: [
    {
      type: 'markdown_text',
      markdown_text: deltaText,   // デルタベース: 新しい文字のみ送信
    },
  ],
});
```

#### stopStream

```typescript
await client.chat.stopStream({
  channel,
  message_ts: streamTs,
  thread_ts: threadTs,
  chunks: [
    {
      type: 'markdown_text',
      markdown_text: finalChunk,
    },
  ],
  // stopStream でのみ Block Kit を添付可能
  blocks: feedbackBlocks,
});
```

### Chunks の種類

ストリーミング中に送信可能なチャンクは3種類：

```typescript
// テキストチャンク
{ type: 'markdown_text', markdown_text: 'テキスト内容' }

// タスク更新チャンク（エージェントのステップ表示）
{
  type: 'task_update',
  task: {
    task_id: 'task_1',
    title: 'データベースを検索中...',
    status: 'in_progress',  // 'pending' | 'in_progress' | 'complete' | 'error'
    details: '検索クエリを実行しています',
    output: { type: 'rich_text', elements: [...] },
    sources: [{ type: 'url', url: 'https://...', text: 'source name' }],
  },
}

// プラン更新チャンク（プラン全体のタイトル変更）
{ type: 'plan_update', title: 'タスク完了' }
```

### フィードバックブロック

```typescript
const feedbackBlocks = [
  {
    type: 'context_actions',
    elements: [
      {
        type: 'feedback_buttons',
        action_id: 'feedback',
        positive_button: {
          text: { type: 'plain_text', text: 'Good Response' },
          value: 'good-feedback',
        },
        negative_button: {
          text: { type: 'plain_text', text: 'Bad Response' },
          value: 'bad-feedback',
        },
      },
    ],
  },
];
```

参照: [Feedback block](https://docs.slack.dev/ai/developing-ai-apps#feedback) / [context_actions block](https://docs.slack.dev/reference/block-kit/blocks/context-actions-block/) / [feedback_buttons element](https://docs.slack.dev/reference/block-kit/blocks/context-actions-block/)

### スロットリングとエラーハンドリング

OpenClaw の本番実装から得られた知見（[Issue #4391](https://github.com/openclaw/openclaw/issues/4391)）：

- `appendStream` は最低 50〜100ms 間隔でスロットリングする（Rate Limit: Tier 2, 20+/min）
- バッファリング: 小さすぎるチャンクは結合してから送信
- フォールバック: ストリーミングに失敗した場合は `chat.postMessage` に切り替え
- デルタベース: `appendStream` には新しく追加された文字のみを送信

```typescript
class SlackStreamThrottler {
  private buffer = '';
  private lastSendTime = 0;
  private minInterval: number;

  constructor(minIntervalMs = 100) {
    this.minInterval = minIntervalMs;
  }

  async append(text: string, sendFn: (text: string) => Promise<void>) {
    this.buffer += text;
    const now = Date.now();
    if (now - this.lastSendTime >= this.minInterval && this.buffer.length > 0) {
      const chunk = this.buffer;
      this.buffer = '';
      this.lastSendTime = now;
      await sendFn(chunk);
    }
  }

  async flush(sendFn: (text: string) => Promise<void>) {
    if (this.buffer.length > 0) {
      await sendFn(this.buffer);
      this.buffer = '';
    }
  }
}
```

---

## コア実装設計

### ノード定義（TypeScript 擬似コード）

```typescript
import {
  IExecuteFunctions,
  INodeType,
  INodeTypeDescription,
  NodeConnectionType,
  NodeConnectionTypes,
} from 'n8n-workflow';
import { streamText, tool } from 'ai';
import { WebClient } from '@slack/web-api';

export class SlackAiStreamingAgent implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Slack AI Streaming Agent',
    name: 'slackAiStreamingAgent',
    icon: 'file:slack-ai.svg',
    group: ['transform'],
    version: 1,
    description: 'AI Agent with native Slack streaming output',
    defaults: { name: 'Slack AI Streaming Agent' },
    inputs: [
      { type: NodeConnectionTypes.Main },
      {
        type: NodeConnectionTypes.AiLanguageModel,
        displayName: 'Model',
        required: true,
        maxConnections: 1,
      },
      {
        type: NodeConnectionTypes.AiTool,
        displayName: 'Tools',
      },
      {
        type: NodeConnectionTypes.AiMemory,
        displayName: 'Memory',
        maxConnections: 1,
      },
    ],
    outputs: [NodeConnectionTypes.Main],
    credentials: [
      {
        name: 'slackApi',
        required: true,
      },
    ],
    properties: [
      // ... パラメータ定義
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    // 実装は「コア実行フロー」セクション参照
  }
}
```

### コア実行フロー

```typescript
async execute(this: IExecuteFunctions) {
  const slackClient = new WebClient(credentials.accessToken);
  const channel = this.getNodeParameter('channelId', 0) as string;
  const threadTs = this.getNodeParameter('threadTs', 0) as string;
  const userId = this.getNodeParameter('recipientUserId', 0) as string;
  const teamId = this.getNodeParameter('recipientTeamId', 0) as string;

  // 1. ステータス表示
  await slackClient.apiCall('assistant.threads.setStatus', {
    channel_id: channel,
    thread_ts: threadTs,
    status: 'thinking...',
  });

  // 2. サブノードから Model / Tools / Memory を取得
  const model = await getConnectedModel(this);
  const tools = await getConnectedTools(this);
  const memory = await getConnectedMemory(this);

  // 3. メモリから履歴取得
  const chatHistory = memory ? await memory.getMessages() : [];

  // 4. streamText() でストリーミング実行
  const throttler = new SlackStreamThrottler(100);
  let streamTs: string | null = null;
  let fullResponse = '';

  const result = streamText({
    model,
    system: systemPrompt,
    messages: [...chatHistory, { role: 'user', content: userPrompt }],
    tools,
    maxSteps: maxIterations,
    onStepFinish: async (step) => {
      // Tool 実行完了時に task_update チャンクを送信
      if (step.toolCalls?.length && streamTs) {
        for (const tc of step.toolCalls) {
          await slackClient.chat.appendStream({
            channel,
            message_ts: streamTs,
            thread_ts: threadTs,
            chunks: [{
              type: 'task_update',
              task: {
                task_id: tc.toolCallId,
                title: `${tc.toolName}`,
                status: 'complete',
              },
            }],
          });
        }
      }
    },
  });

  // 5. トークンストリームを Slack に中継
  for await (const delta of result.textStream) {
    fullResponse += delta;

    if (!streamTs) {
      // 最初のチャンクで startStream
      const startResp = await slackClient.chat.startStream({
        channel,
        thread_ts: threadTs,
        recipient_team_id: teamId,
        recipient_user_id: userId,
        task_display_mode: taskDisplayMode,
        chunks: [{ type: 'markdown_text', markdown_text: delta }],
      });
      streamTs = startResp.ts;
    } else {
      // 後続チャンクは throttled appendStream
      await throttler.append(delta, async (text) => {
        await slackClient.chat.appendStream({
          channel,
          message_ts: streamTs,
          thread_ts: threadTs,
          chunks: [{ type: 'markdown_text', markdown_text: text }],
        });
      });
    }
  }

  // 6. バッファの残りをフラッシュ
  await throttler.flush(async (text) => {
    await slackClient.chat.appendStream({
      channel,
      message_ts: streamTs!,
      thread_ts: threadTs,
      chunks: [{ type: 'markdown_text', markdown_text: text }],
    });
  });

  // 7. stopStream で完了
  await slackClient.chat.stopStream({
    channel,
    message_ts: streamTs!,
    thread_ts: threadTs,
    chunks: [],
    ...(enableFeedback ? { blocks: feedbackBlocks } : {}),
  });

  // 8. メモリに保存
  if (memory) {
    await memory.addMessage({ role: 'user', content: userPrompt });
    await memory.addMessage({ role: 'assistant', content: fullResponse });
  }

  // 9. 出力
  return [[{
    json: {
      message_ts: streamTs,
      channel,
      thread_ts: threadTs,
      response_text: fullResponse,
      token_count: (await result.usage)?.totalTokens,
    },
  }]];
}
```

---

## サブノード接続の実装

`n8n-nodes-better-ai-agent` の `utils/` ディレクトリに含まれるヘルパー関数を参考にする。

参照: [BetterAiAgent.node.ts](https://github.com/fjrdomingues/n8n-nodes-better-ai-agent/blob/main/BetterAiAgent.node.ts) / [utils/](https://github.com/fjrdomingues/n8n-nodes-better-ai-agent/tree/main/utils)

### Model 接続

```typescript
import { getConnectedModel } from './utils';

// n8n の AI Model サブノード（OpenAI, Anthropic 等）から
// Vercel AI SDK 互換の model オブジェクトを取得
const model = await getConnectedModel(this);
```

### Tools 接続

```typescript
import { getConnectedTools } from './utils';

// n8n の Tool サブノード群から
// Vercel AI SDK の tool() オブジェクト群を取得
const tools = await getConnectedTools(this);
```

### Memory 接続

```typescript
import { getConnectedMemory } from './utils';

// n8n の Memory サブノードからチャット履歴を取得
const memory = await getConnectedMemory(this);
```

> **注意:** `n8n-nodes-better-ai-agent` は n8n の標準 LangChain サブノードと直接互換ではなく、独自のアダプタ層を持っている。n8n 標準の Model/Memory ノードを接続する場合は、LangChain → Vercel AI SDK の変換レイヤーが必要になる可能性がある。この部分は実装時に検証が必要。

---

## Slack AI Apps 側のセットアップ要件

本ノードを使用するワークフローを動作させるには、Slack App 側で以下の設定が必要：

### App 設定

1. [App Settings](https://api.slack.com/apps) で **Agents & AI Apps** 機能をトグル ON
2. `assistant:write` スコープが自動追加される（マニフェストで確認可能）
3. Event Subscriptions で以下のイベントを購読:
   - `assistant_thread_started`
   - `assistant_thread_context_changed`
   - `message.im`

### 必要なスコープ

| スコープ | 用途 |
|---|---|
| `chat:write` | メッセージ送信、ストリーミング |
| `assistant:write` | AI Apps 機能（ステータス、プロンプト、タイトル） |
| `im:history` | DM スレッドの会話履歴取得 |

### Manifest 例

```json
{
  "display_information": {
    "name": "My AI Agent"
  },
  "features": {
    "bot_user": {
      "display_name": "My AI Agent",
      "always_online": true
    },
    "assistant_view": {
      "assistant_description": "Ask me anything",
      "suggested_prompts": []
    }
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "chat:write",
        "assistant:write",
        "im:history"
      ]
    }
  },
  "settings": {
    "event_subscriptions": {
      "request_url": "https://your-n8n-domain.example.com/webhook/slack-events",
      "bot_events": [
        "assistant_thread_started",
        "assistant_thread_context_changed",
        "message.im"
      ]
    }
  }
}
```

参照: [Slack App Flow](https://docs.slack.dev/ai/developing-ai-apps#app-flow) / [Agents & AI Apps feature toggle](https://docs.slack.dev/ai/developing-ai-apps#implement)

---

## n8n ワークフロー構成例

### メインワークフロー

```
[Webhook Trigger: /slack-events]
  │
  ├─ (event_type == "assistant_thread_started")
  │   └→ [HTTP Request] assistant.threads.setSuggestedPrompts
  │
  ├─ (event_type == "message.im")
  │   └→ [Slack AI Streaming Agent]  ← 本ノード
  │        ├── Model: OpenAI Chat Model (gpt-4o)
  │        ├── Tools: HTTP Request Tool, Code Tool
  │        └── Memory: Window Buffer Memory
  │
  └→ [後処理] ログ、エラーハンドリング
```

### Webhook Trigger 設定

- HTTP Method: POST
- Path: `/slack-events`
- Response Mode: **Immediately**（Slack の 3 秒タイムアウト対策）
- Response Code: 200
- Response Data: `{ "challenge": "{{ $json.challenge }}" }`（URL verification 用）

> **重要:** Slack Events API は 3 秒以内に 200 応答を要求する。Webhook Trigger の Response Mode は「Immediately」に設定し、ストリーミング処理は非同期で実行する必要がある。

---

## 開発手順

### Phase 1: スキャフォールディング

```bash
# n8n-nodes-starter をテンプレートとして使用
git clone https://github.com/n8n-io/n8n-nodes-starter.git n8n-nodes-slack-ai-streaming-agent
cd n8n-nodes-slack-ai-streaming-agent
npm install

# 依存パッケージ追加
npm install ai @ai-sdk/openai @ai-sdk/anthropic @ai-sdk/google @slack/web-api
```

参照: [n8n-nodes-starter](https://github.com/n8n-io/n8n-nodes-starter) / [Building community nodes](https://docs.n8n.io/integrations/community-nodes/build-community-nodes/) / [Creating nodes overview](https://docs.n8n.io/integrations/creating-nodes/overview/)

### Phase 2: ノード定義・サブノード接続

- `n8n-nodes-better-ai-agent` の `BetterAiAgent.node.ts` と `utils/` をフォークベースに
- `NodeConnectionTypes.AiLanguageModel` / `AiTool` / `AiMemory` の input 定義
- Slack credential の接続

### Phase 3: Slack Streaming Layer

- `SlackStreamManager` クラスの実装（startStream / appendStream / stopStream のラッパー）
- スロットリング、バッファリング、フォールバック（OpenClaw Issue #4391 を参考に）
- task_update チャンクの生成ロジック

### Phase 4: Agent 実行ループ

- Vercel AI SDK の `streamText()` 統合
- Tool 実行時のステップ表示
- Memory の読み書き
- エラーハンドリング・リトライ

### Phase 5: テスト・デプロイ

```bash
# ビルド
npm run build

# Docker 環境でのテスト（n8n コンテナにボリュームマウント）
# docker-compose.yml に以下を追加:
# volumes:
#   - ./dist:/home/node/.n8n/custom/node_modules/n8n-nodes-slack-ai-streaming-agent

# npm publish 前の動作確認
npm run lint
npm test
```

参照: [Developing Custom Nodes for n8n with Docker](https://dev.to/hubschrauber/developing-custom-nodes-for-n8n-with-docker-3poj) / [Install and manage community nodes](https://docs.n8n.io/integrations/community-nodes/installation/)

---

## ディレクトリ構成

```
n8n-nodes-slack-ai-streaming-agent/
├── credentials/
│   └── SlackAiApi.credentials.ts
├── nodes/
│   └── SlackAiStreamingAgent/
│       ├── SlackAiStreamingAgent.node.ts    # ノード定義・execute
│       ├── slack-stream.ts                  # Slack Streaming ラッパー
│       ├── agent-executor.ts                # streamText() 実行ループ
│       ├── types.ts                         # 型定義
│       └── slack-ai.svg                     # アイコン
├── utils/
│   ├── getConnectedModel.ts                 # Model サブノード取得
│   ├── getConnectedTools.ts                 # Tools サブノード取得
│   ├── getConnectedMemory.ts                # Memory サブノード取得
│   └── chatArrayMemory.ts                   # メモリアダプタ
├── package.json
├── tsconfig.json
└── README.md
```

---

## リスクと制約

### 既知のリスク

| リスク | 影響度 | 対策 |
|---|---|---|
| n8n 標準 LangChain サブノードと Vercel AI SDK の互換性 | 高 | アダプタ層の実装、実機テストで検証 |
| Slack appendStream の Rate Limit (Tier 2: 20+/min) | 中 | スロットリング + バッファリング |
| `recipient_team_id` / `recipient_user_id` が未ドキュメント | 中 | OpenClaw の本番実装で動作確認済み |
| n8n バージョンアップで NodeConnectionTypes の仕様変更 | 低 | Vercel AI SDK ベースで内部 API 依存を最小化 |
| Slack AI Apps 機能が有料プラン限定 | — | [Developer Program](https://api.slack.com/developer-program) で無料サンドボックス利用可 |

### 制約

- Slack のストリーミングはスレッド内でのみ動作する（DM はすべてスレッドだが、チャンネルでは `thread_ts` が必須）
- `chat.startStream` / `chat.appendStream` では Block Kit は使用不可（`chat.stopStream` でのみ可能）
- ストリーミング中の unfurl は無効化される
- Workspace ゲストは Agents & AI Apps 機能にアクセスできない

---

## 参考リンク集

### Slack AI Apps

- [Developing apps with AI features](https://docs.slack.dev/ai/developing-ai-apps/) — メイン開発ガイド
- [AI in Slack apps overview](https://docs.slack.dev/ai/) — 概要・ユースケース
- [Best practices for AI-enabled apps](https://docs.slack.dev/ai/ai-apps-best-practices)
- [Slack MCP Server](https://docs.slack.dev/ai/slack-mcp-server) — MCP プロトコル対応

### Slack API Methods

- [chat.startStream](https://docs.slack.dev/reference/methods/chat.startStream)
- [chat.appendStream](https://docs.slack.dev/reference/methods/chat.appendStream)
- [chat.stopStream](https://docs.slack.dev/reference/methods/chat.stopStream)
- [assistant.threads.setStatus](https://docs.slack.dev/reference/methods/assistant.threads.setStatus)
- [assistant.threads.setSuggestedPrompts](https://docs.slack.dev/reference/methods/assistant.threads.setSuggestedPrompts)
- [assistant.threads.setTitle](https://docs.slack.dev/reference/methods/assistant.threads.setTitle)

### Slack Events

- [assistant_thread_started](https://docs.slack.dev/reference/events/assistant_thread_started)
- [assistant_thread_context_changed](https://docs.slack.dev/reference/events/assistant_thread_context_changed)
- [message.im](https://docs.slack.dev/reference/events/message.im)

### Slack Block Kit

- [task_card block](https://docs.slack.dev/reference/block-kit/blocks/task-card-block)
- [plan block](https://docs.slack.dev/reference/block-kit/blocks/plan-block)
- [context_actions block](https://docs.slack.dev/reference/block-kit/blocks/context-actions-block/)
- [feedback_buttons element](https://docs.slack.dev/reference/block-kit/block-elements/feedback-buttons-element/)

### n8n カスタムノード開発

- [Creating nodes overview](https://docs.n8n.io/integrations/creating-nodes/overview/) — 公式ガイド
- [Building community nodes](https://docs.n8n.io/integrations/community-nodes/build-community-nodes/) — コミュニティノード要件
- [n8n-nodes-starter](https://github.com/n8n-io/n8n-nodes-starter) — テンプレートリポジトリ
- [Install and manage community nodes](https://docs.n8n.io/integrations/community-nodes/installation/)
- [Developing Custom Nodes with Docker](https://dev.to/hubschrauber/developing-custom-nodes-for-n8n-with-docker-3poj)

### 参考実装（GitHub）

- [n8n-nodes-better-ai-agent](https://github.com/fjrdomingues/n8n-nodes-better-ai-agent) — Vercel AI SDK ベースのカスタム AI Agent ノード
- [n8n-nodes-streaming-ai-agent](https://github.com/jasonrlee6/n8n-node-ai-agent-with-streaming) — AG-UI プロトコル対応ストリーミング
- [n8n-slack-socket-mode](https://github.com/mbakgun/n8n-slack-socket-mode) — Slack Socket Mode コミュニティノード
- [OpenClaw Issue #4391](https://github.com/openclaw/openclaw/issues/4391) — Slack native streaming の本番実装詳細

### n8n AI / LangChain

- [LangChain in n8n](https://docs.n8n.io/advanced-ai/langchain/overview/)
- [AI Agent node](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.agent/)
- [Tools Agent](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.agent/tools-agent/)
- [Streaming responses](https://docs.n8n.io/workflows/streaming/)

### Slack Bolt（参考: standalone 方式の場合）

- [Bolt for Python AI Apps](https://docs.slack.dev/tools/bolt-python/concepts/ai-apps)
- [Bolt for JavaScript AI Apps](https://docs.slack.dev/tools/bolt-js/concepts/ai-apps)
- [bolt-python-assistant-template](https://github.com/slack-samples/bolt-python-assistant-template)
- [bolt-js-assistant-template](https://github.com/slack-samples/bolt-js-assistant-template)
