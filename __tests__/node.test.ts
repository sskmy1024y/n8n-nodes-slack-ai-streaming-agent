import { SlackAiStreamingAgent } from '../nodes/SlackAiStreamingAgent/SlackAiStreamingAgent.node';

describe('SlackAiStreamingAgent node definition', () => {
  const node = new SlackAiStreamingAgent();
  const desc = node.description;

  it('has correct name', () => {
    expect(desc.name).toBe('slackAiStreamingAgent');
  });

  it('has correct displayName', () => {
    expect(desc.displayName).toBe('Slack AI Streaming Agent');
  });

  it('is version 1', () => {
    expect(desc.version).toBe(1);
  });

  it('requires slackApi credential', () => {
    expect(desc.credentials).toEqual([
      { name: 'slackApi', required: true },
    ]);
  });

  describe('inputs', () => {
    const inputs = desc.inputs as Array<{ type: string; displayName?: string; required?: boolean; maxConnections?: number }>;

    it('has 4 inputs', () => {
      expect(inputs).toHaveLength(4);
    });

    it('has main input', () => {
      expect(inputs[0].type).toBe('main');
    });

    it('has required AI Language Model input', () => {
      const modelInput = inputs.find((i) => i.displayName === 'Model');
      expect(modelInput).toBeDefined();
      expect(modelInput!.required).toBe(true);
      expect(modelInput!.maxConnections).toBe(1);
    });

    it('has optional Tools input', () => {
      const toolsInput = inputs.find((i) => i.displayName === 'Tools');
      expect(toolsInput).toBeDefined();
      expect(toolsInput!.required).toBeUndefined();
    });

    it('has optional Memory input', () => {
      const memoryInput = inputs.find((i) => i.displayName === 'Memory');
      expect(memoryInput).toBeDefined();
      expect(memoryInput!.maxConnections).toBe(1);
    });
  });

  describe('properties', () => {
    const props = desc.properties;
    const propNames = props.map((p) => p.name);

    it('has required Slack parameters', () => {
      expect(propNames).toContain('channelId');
      expect(propNames).toContain('threadTs');
      expect(propNames).toContain('recipientUserId');
      expect(propNames).toContain('recipientTeamId');
    });

    it('has prompt parameters', () => {
      expect(propNames).toContain('promptSource');
      expect(propNames).toContain('prompt');
      expect(propNames).toContain('systemPrompt');
    });

    it('has options collection', () => {
      expect(propNames).toContain('options');
      const optionsProp = props.find((p) => p.name === 'options');
      expect(optionsProp!.type).toBe('collection');
    });

    it('prompt is conditionally shown when promptSource is defineBelow', () => {
      const promptProp = props.find((p) => p.name === 'prompt');
      expect(promptProp!.displayOptions).toEqual({
        show: { promptSource: ['defineBelow'] },
      });
    });

    describe('options sub-properties', () => {
      const optionsProp = props.find((p) => p.name === 'options');
      const subOptions = optionsProp!.options as Array<{ name: string; default?: unknown }>;
      const subNames = subOptions.map((o) => o.name);

      it('has maxIterations with default 10', () => {
        const maxIter = subOptions.find((o) => o.name === 'maxIterations');
        expect(maxIter!.default).toBe(10);
      });

      it('has streamBufferSize with default 64', () => {
        const buf = subOptions.find((o) => o.name === 'streamBufferSize');
        expect(buf!.default).toBe(64);
      });

      it('has feedbackButtons with default false', () => {
        const fb = subOptions.find((o) => o.name === 'feedbackButtons');
        expect(fb!.default).toBe(false);
      });

      it('has setThreadTitle with default false', () => {
        const title = subOptions.find((o) => o.name === 'setThreadTitle');
        expect(title!.default).toBe(false);
      });
    });
  });
});
