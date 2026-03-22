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
import type { PromptSource, TaskDisplayMode } from './types';

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
        required: true,
      },
    ],
    properties: [
      // --- Slack Parameters ---
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
      // --- Prompt Parameters ---
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
        typeOptions: {
          rows: 4,
        },
        default: '',
        displayOptions: {
          show: {
            promptSource: ['defineBelow'],
          },
        },
        description: 'The user prompt to send to the AI model',
      },
      {
        displayName: 'System Prompt',
        name: 'systemPrompt',
        type: 'string',
        typeOptions: {
          rows: 6,
        },
        default: '',
        description: 'Optional system prompt for the AI model',
      },
      // --- Agent Options ---
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        placeholder: 'Add Option',
        default: {},
        options: [
          {
            displayName: 'Task Display Mode',
            name: 'taskDisplayMode',
            type: 'options',
            options: [
              {
                name: 'Timeline',
                value: 'timeline',
                description: 'Show each tool step individually',
              },
              {
                name: 'Plan',
                value: 'plan',
                description: 'Group tool steps together',
              },
            ],
            default: 'timeline',
            description: 'How tool execution steps are displayed in the Slack stream',
          },
          {
            displayName: 'Max Iterations',
            name: 'maxIterations',
            type: 'number',
            typeOptions: {
              minValue: 1,
              maxValue: 50,
            },
            default: 10,
            description: 'Maximum number of tool call iterations',
          },
          {
            displayName: 'Append Throttle (ms)',
            name: 'appendThrottleMs',
            type: 'number',
            typeOptions: {
              minValue: 50,
              maxValue: 1000,
            },
            default: 100,
            description: 'Minimum interval between appendStream calls',
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
            description:
              'Whether to automatically set the thread title from the first user message',
          },
          {
            displayName: 'Max Title Length',
            name: 'maxTitleLength',
            type: 'number',
            typeOptions: {
              minValue: 10,
              maxValue: 200,
            },
            default: 50,
            displayOptions: {
              show: {
                setThreadTitle: [true],
              },
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

    const credentials = await this.getCredentials('slackApi');
    const slackClient = new WebClient(credentials.accessToken as string);

    for (let i = 0; i < items.length; i++) {
      const startTime = Date.now();

      const channel = this.getNodeParameter('channelId', i) as string;
      const threadTs = this.getNodeParameter('threadTs', i) as string;
      const userId = this.getNodeParameter('recipientUserId', i) as string;
      const teamId = this.getNodeParameter('recipientTeamId', i) as string;
      const promptSource = this.getNodeParameter('promptSource', i) as PromptSource;
      const systemPrompt = this.getNodeParameter('systemPrompt', i, '') as string;
      const options = this.getNodeParameter('options', i, {}) as {
        taskDisplayMode?: TaskDisplayMode;
        maxIterations?: number;
        appendThrottleMs?: number;
        feedbackButtons?: boolean;
        setThreadTitle?: boolean;
        maxTitleLength?: number;
      };

      // Resolve user prompt
      let userPrompt: string;
      if (promptSource === 'defineBelow') {
        userPrompt = this.getNodeParameter('prompt', i) as string;
      } else {
        // Auto-detect from chatInput or input data
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

      // Initialize Slack stream manager
      const streamManager = new SlackStreamManager({
        client: slackClient,
        channel,
        threadTs,
        recipientUserId: userId,
        recipientTeamId: teamId,
        taskDisplayMode: options.taskDisplayMode ?? 'timeline',
        throttleMs: options.appendThrottleMs ?? 100,
        enableFeedback: options.feedbackButtons ?? false,
      });

      try {
        await streamManager.setStatus('thinking...');

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
          // Fire-and-forget — non-critical, don't block agent execution
          void streamManager.setTitle(title);
        }

        const result = await executeAgent({
          model,
          tools,
          systemPrompt: systemPrompt || undefined,
          messages,
          maxSteps: options.maxIterations ?? 10,
          streamManager,
        });

        await streamManager.stop();

        if (memoryAdapter) {
          await memoryAdapter.save([
            { role: 'user', content: userPrompt },
            ...result.newMessages,
          ]);
        }

        const durationMs = Date.now() - startTime;
        returnData.push({
          json: {
            message_ts: streamManager.messageTs,
            channel,
            thread_ts: threadTs,
            response_text: result.responseText,
            intermediate_steps: result.intermediateSteps,
            token_count: result.tokenCount,
            duration_ms: durationMs,
          },
        });
      } catch (error) {
        // Ensure stream is stopped on error
        try {
          await streamManager.stop();
        } catch {
          // Ignore stop errors during error handling
        }

        // Post error message to Slack thread
        try {
          await slackClient.chat.postMessage({
            channel,
            thread_ts: threadTs,
            text: `An error occurred while processing your request. Please try again.`,
          });
        } catch {
          // Ignore Slack error notification failure
        }

        throw error;
      }
    }

    return [returnData];
  }
}
