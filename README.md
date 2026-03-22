# n8n-nodes-slack-ai-streaming-agent

A custom n8n community node that streams AI agent responses to Slack in real time using the native Slack AI Apps streaming API. Supports the same sub-node connections (Model / Tools / Memory) as n8n's built-in AI Agent node.

## Demo

https://github.com/user-attachments/assets/78b9b67e-76cb-427a-805f-f34c83b4b932

## Features

- **Real-time streaming** — Tokens appear in Slack as they are generated, just like ChatGPT or Claude
- **No "edited" label** — Uses Slack's native streaming API, not message editing
- **Sub-node connections** — Connect any n8n LangChain model, tool, or memory node
- **Tool step display** — Tool execution steps shown as `task_update` chunks in the Slack UI
- **Automatic fallback** — Falls back to `chat.postMessage` if streaming fails
- **Feedback buttons** — Optional thumbs up/down buttons on responses

## Prerequisites

- **n8n** v1.0+ (self-hosted)
- **Slack App** with **Agents & AI Apps** feature enabled
- **Node.js** 18+

## Installation

### Option 1: npm (recommended)

Install via the n8n GUI:

1. **Settings** > **Community Nodes** > **Install a community node**
2. Enter `n8n-nodes-slack-ai-streaming-agent`
3. Click **Install**

Or via CLI:

```bash
cd ~/.n8n/custom
npm install n8n-nodes-slack-ai-streaming-agent
```

### Option 2: Build from source

```bash
git clone <repository-url> n8n-nodes-slack-ai-streaming-agent
cd n8n-nodes-slack-ai-streaming-agent
npm install
npm run build
```

Then link to n8n:

```bash
npm link
cd ~/.n8n/custom
npm link n8n-nodes-slack-ai-streaming-agent
```

### Option 3: Docker (volume mount)

Add to your `docker-compose.yml`:

```yaml
services:
  n8n:
    image: n8nio/n8n
    volumes:
      - ./n8n-nodes-slack-ai-streaming-agent/dist:/home/node/.n8n/custom/node_modules/n8n-nodes-slack-ai-streaming-agent/dist
      - ./n8n-nodes-slack-ai-streaming-agent/package.json:/home/node/.n8n/custom/node_modules/n8n-nodes-slack-ai-streaming-agent/package.json
```

> **Note:** Restart n8n after installation.

## Slack App Setup

### 1. Create and configure the app

1. Create a new app at [Slack API](https://api.slack.com/apps)
2. Enable **Agents & AI Apps** under **Features**
3. Add the following scopes under **OAuth & Permissions**:

| Scope | Purpose |
|---|---|
| `chat:write` | Send messages and stream |
| `assistant:write` | AI Apps features (status, prompts, title) |
| `im:history` | Read DM thread history |
| `channels:history` | Read channel thread history |
| `app_mentions:read` | Receive @mention events in channels |

### 2. Subscribe to events

Enable **Event Subscriptions** and set the Request URL to your n8n webhook:

```
https://your-n8n-domain.example.com/webhook/slack-events
```

Subscribe to these Bot Events:

- `assistant_thread_started`
- `assistant_thread_context_changed`
- `message.im`
- `message.channels`
- `app_mention`

### 3. App Manifest

Use the template [`examples/slack-app-manifest.json`](examples/slack-app-manifest.json):

1. Replace `request_url` with your actual n8n webhook URL
2. Paste into [Slack API](https://api.slack.com/apps) > **App Manifests**

### 4. Get the Bot Token

**OAuth & Permissions** > **Install to Workspace** > Copy the **Bot User OAuth Token** (`xoxb-...`).

## Usage in n8n

### 1. Set up credentials

Uses n8n's built-in Slack credential:

1. **Credentials** > **New Credential** > **Slack API**
2. Enter the `xoxb-...` token in the **Access Token** field
3. **Save** > **Test**

> You can reuse an existing Slack credential if you have one.

### 2. Build the workflow

Import the template [`examples/slack-ai-agent-workflow.json`](examples/slack-ai-agent-workflow.json) into n8n:

> **How to import:** Click **...** (top right) > **Import from File** > Select the JSON file

#### Workflow structure

```
[Webhook]
  |
  +- Respond 200 (immediate response to Slack)
  |
  +- Route by Event (Switch)
       |
       +- (assistant_thread_started)
       |   -> [Set Suggested Prompts]
       |
       +- (app_mention / message.im)
           -> [Extract Event Data]
               -> [Slack AI Streaming Agent]
                    +-- Model: OpenAI Chat Model
                    +-- Tools: (optional)
                    +-- Memory: Window Buffer Memory
```

#### Webhook settings

| Setting | Value |
|---|---|
| HTTP Method | POST |
| Path | `/slack-events` |
| Response Mode | **Using 'Respond to Webhook' Node** |

> **Important:** Slack Events API requires a 200 response within 3 seconds. The Respond 200 node handles this immediately, allowing the workflow to continue processing asynchronously.

#### Slack AI Streaming Agent parameters

| Parameter | Example | Description |
|---|---|---|
| Channel ID | `{{ $json.channel }}` | Channel from the Slack event |
| Thread TS | `{{ $json.thread_ts }}` | Thread timestamp |
| Recipient User ID | `{{ $json.user_id }}` | User who sent the message |
| Recipient Team ID | `{{ $json.team_id }}` | Workspace ID |
| Prompt Source | Take from Previous Node | Auto-detects `chatInput` from input |
| System Prompt | (optional) | Instructions for the AI model |

#### Options

| Option | Default | Description |
|---|---|---|
| Max Iterations | `10` | Maximum tool call iterations |
| Stream Buffer Size | `64` | Characters to buffer before sending to Slack (smaller = more frequent updates) |
| Feedback Buttons | `false` | Show thumbs up/down buttons after the response |
| Set Thread Title | `false` | Auto-set thread title from the user's message |

### 3. Connect sub-nodes

#### Model (required)

Connect any n8n LLM model node:

- OpenAI Chat Model
- Anthropic Chat Model
- Google Gemini Chat Model

#### Tools (optional)

- HTTP Request Tool
- Code Tool
- Calculator
- Any custom tool

#### Memory (optional)

- Window Buffer Memory (in-memory, lost on restart)
- Postgres Chat Memory (persistent, recommended for production)
- Redis Chat Memory (persistent)

### 4. Output data

The node outputs:

```json
{
  "channel": "D324567865",
  "thread_ts": "1724264400.000000",
  "response_text": "The full AI response text",
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

## Development

```bash
npm install       # Install dependencies
npm run build     # Build
npm run lint      # Type check
npm test          # Run tests
npm run dev       # Watch mode
```

## Limitations

- Streaming only works **within threads** (DMs are always threaded)
- Block Kit cannot be used during streaming (only on `stopStream`)
- Unfurls are disabled during streaming
- Workspace guests cannot access the Agents & AI Apps feature
- Slack AI Apps requires a paid plan ([Developer Program](https://api.slack.com/developer-program) offers a free sandbox)

## License

MIT
