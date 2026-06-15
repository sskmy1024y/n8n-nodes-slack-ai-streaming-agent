import type {
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
  INodeInputConfiguration,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';
import { WebClient } from '@slack/web-api';

import { getConnectedModel, getConnectedTools, getConnectedMemory, ChatArrayMemory } from '../../utils';
import { SlackStreamManager } from './slack-stream';
import { executeAgent } from './agent-executor';
import type { AgentStreamManager, PromptSource } from './types';

class DebugStreamManager implements AgentStreamManager {
  private textChunks: string[] = [];
  readonly taskUpdates: Array<{
    taskId: string;
    title: string;
    status: 'pending' | 'in_progress' | 'complete' | 'error';
    details?: string;
  }> = [];

  get responseText(): string {
    return this.textChunks.join('');
  }

  appendText(delta: string): void {
    this.textChunks.push(delta);
  }

  async sendTaskUpdate(
    taskId: string,
    title: string,
    status: 'pending' | 'in_progress' | 'complete' | 'error',
    details?: string,
  ): Promise<void> {
    this.taskUpdates.push({ taskId, title, status, ...(details ? { details } : {}) });
  }
}

export class SlackAiStreamingAgent implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Slack AI Streaming Agent',
    name: 'slackAiStreamingAgent',
    icon: 'file:slack-ai.svg',
    group: ['transform'],
    version: 1,
    description: 'AI Agent with native Slack streaming output',
    defaults: {
      name: 'Slack AI Streaming Agent',
    },
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - codex is valid at runtime but not in the type definition
    codex: {
      categories: ['AI'],
      subcategories: {
        AI: ['Agents'],
      },
    },
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
    ] as INodeInputConfiguration[],
    outputs: [NodeConnectionTypes.Main] as unknown as INodeTypeDescription['outputs'],
    credentials: [
      {
        name: 'slackApi',
        required: false,
      },
    ],
    properties: [
      {
        displayName: 'Channel ID',
        name: 'channelId',
        type: 'string',
        default: '',
        required: true,
        description: 'DM channel ID from the Slack event',
        placeholder: 'D0123456789',
      },
      {
        displayName: 'Thread TS',
        name: 'threadTs',
        type: 'string',
        default: '',
        required: true,
        description: 'Thread timestamp from the Slack event',
      },
      {
        displayName: 'Recipient User ID',
        name: 'recipientUserId',
        type: 'string',
        default: '',
        required: true,
        description: 'User ID of the stream recipient',
        placeholder: 'U0123456789',
      },
      {
        displayName: 'Recipient Team ID',
        name: 'recipientTeamId',
        type: 'string',
        default: '',
        required: true,
        description: 'Workspace (team) ID',
        placeholder: 'T0123456789',
      },
      {
        displayName: 'Prompt Source',
        name: 'promptSource',
        type: 'options',
        options: [
          {
            name: 'Take from Previous Node',
            value: 'takePreviousNode',
            description: 'Use chatInput from the previous node',
          },
          {
            name: 'Define Below',
            value: 'defineBelow',
            description: 'Enter the prompt manually',
          },
        ],
        default: 'takePreviousNode',
      },
      {
        displayName: 'Prompt',
        name: 'prompt',
        type: 'string',
        typeOptions: { rows: 4 },
        default: '',
        displayOptions: {
          show: { promptSource: ['defineBelow'] },
        },
        description: 'The user prompt to send to the AI model',
      },
      {
        displayName: 'System Prompt',
        name: 'systemPrompt',
        type: 'string',
        typeOptions: { rows: 6 },
        default: '',
        description: 'Optional system prompt for the AI model',
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        placeholder: 'Add Option',
        default: {},
        options: [
          {
            displayName: 'Max Iterations',
            name: 'maxIterations',
            type: 'number',
            typeOptions: { minValue: 1, maxValue: 50 },
            default: 10,
            description: 'Maximum number of tool call iterations',
          },
          {
            displayName: 'Debug Mode (No Slack)',
            name: 'debugMode',
            type: 'boolean',
            default: false,
            description: 'Run the agent inside n8n without calling Slack streaming APIs',
          },
          {
            displayName: 'Stream Buffer Size (chars)',
            name: 'streamBufferSize',
            type: 'number',
            typeOptions: { minValue: 16, maxValue: 512 },
            default: 64,
            description: 'Number of characters to buffer before sending to Slack. Smaller = more frequent updates.',
          },
          {
            displayName: 'Feedback Buttons',
            name: 'feedbackButtons',
            type: 'boolean',
            default: false,
            description: 'Whether to show thumbs up/down feedback buttons after the response',
          },
          {
            displayName: 'Set Thread Title',
            name: 'setThreadTitle',
            type: 'boolean',
            default: false,
            description: 'Whether to automatically set the thread title from the first user message',
          },
          {
            displayName: 'Max Title Length',
            name: 'maxTitleLength',
            type: 'number',
            typeOptions: { minValue: 10, maxValue: 200 },
            default: 50,
            displayOptions: {
              show: { setThreadTitle: [true] },
            },
            description: 'Maximum character length for auto-generated thread titles',
          },
        ],
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const returnData: INodeExecutionData[] = [];

    for (let i = 0; i < items.length; i++) {
      const startTime = Date.now();

      const channel = this.getNodeParameter('channelId', i) as string;
      const threadTs = this.getNodeParameter('threadTs', i) as string;
      const userId = this.getNodeParameter('recipientUserId', i) as string;
      const teamId = this.getNodeParameter('recipientTeamId', i) as string;
      const promptSource = this.getNodeParameter('promptSource', i) as PromptSource;
      const systemPrompt = this.getNodeParameter('systemPrompt', i, '') as string;
      const options = this.getNodeParameter('options', i, {}) as {
        maxIterations?: number;
        debugMode?: boolean;
        streamBufferSize?: number;
        feedbackButtons?: boolean;
        setThreadTitle?: boolean;
        maxTitleLength?: number;
      };
      const debugMode = options.debugMode ?? false;

      let userPrompt: string;
      if (promptSource === 'defineBelow') {
        userPrompt = this.getNodeParameter('prompt', i) as string;
      } else {
        const inputData = items[i].json;
        userPrompt =
          (inputData['chatInput'] as string) ??
          (inputData['text'] as string) ??
          (inputData['message'] as string) ??
          (inputData['content'] as string) ??
          '';
      }

      if (!userPrompt) {
        throw new Error('No user prompt found. Check input data or set Prompt Source to "Define Below".');
      }

      let streamManager: AgentStreamManager;
      let slackClient: WebClient | null = null;

      if (debugMode) {
        streamManager = new DebugStreamManager();
      } else {
        const credentials = await this.getCredentials('slackApi');
        if (!credentials.accessToken) {
          throw new Error('Slack credentials are required unless Debug Mode (No Slack) is enabled.');
        }
        slackClient = new WebClient(credentials.accessToken as string);
        streamManager = new SlackStreamManager({
          client: slackClient,
          channel,
          threadTs,
          recipientUserId: userId,
          recipientTeamId: teamId,
          bufferSize: options.streamBufferSize ?? 64,
          enableFeedback: options.feedbackButtons ?? false,
        });
      }

      try {
        if (streamManager instanceof SlackStreamManager) {
          await streamManager.setStatus('thinking...');
        }

        const [model, tools, memory] = await Promise.all([
          getConnectedModel(this, i),
          getConnectedTools(this, i),
          getConnectedMemory(this, i),
        ]);

        const memoryAdapter = memory ? new ChatArrayMemory(memory) : null;
        const chatHistory = memoryAdapter ? await memoryAdapter.load() : [];

        const messages = [
          ...chatHistory,
          { role: 'user' as const, content: userPrompt },
        ];

        if (options.setThreadTitle) {
          const maxLen = options.maxTitleLength ?? 50;
          const title =
            userPrompt.length > maxLen
              ? userPrompt.substring(0, maxLen) + '...'
              : userPrompt;
          if (streamManager instanceof SlackStreamManager) {
            void streamManager.setTitle(title);
          }
        }

        const result = await executeAgent({
          model,
          tools,
          systemPrompt: systemPrompt || undefined,
          messages,
          maxSteps: options.maxIterations ?? 10,
          streamManager,
        });

        if (streamManager instanceof SlackStreamManager) {
          await streamManager.stop();
        }

        if (memoryAdapter) {
          await memoryAdapter.save([
            { role: 'user', content: userPrompt },
            ...result.newMessages,
          ]);
        }

        returnData.push({
          json: {
            channel,
            thread_ts: threadTs,
            response_text: result.responseText,
            intermediate_steps: result.intermediateSteps,
            connected_tools: tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              hasSchema: tool.schema !== undefined,
              invoker: tool.invoke ? 'invoke' : tool.call ? 'call' : tool.func ? 'func' : null,
            })),
            model_supports_tools: typeof (model as { bindTools?: unknown }).bindTools === 'function',
            debug_mode: debugMode,
            task_updates:
              streamManager instanceof DebugStreamManager ? streamManager.taskUpdates : undefined,
            token_count: result.tokenCount,
            duration_ms: Date.now() - startTime,
          },
        });
      } catch (error) {
        if (streamManager instanceof SlackStreamManager) {
          try { await streamManager.stop(); } catch { /* noop */ }
        }

        if (slackClient) {
          try {
            await slackClient.chat.postMessage({
              channel,
              thread_ts: threadTs,
              text: 'An error occurred while processing your request. Please try again.',
            });
          } catch { /* noop */ }
        }

        throw error;
      }
    }

    return [returnData];
  }
}
