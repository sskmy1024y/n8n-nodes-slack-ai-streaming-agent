import {
  IAuthenticateGeneric,
  ICredentialTestRequest,
  ICredentialType,
  INodeProperties,
} from 'n8n-workflow';

export class SlackAiApi implements ICredentialType {
  name = 'slackAiApi';
  displayName = 'Slack AI API';
  documentationUrl = 'https://api.slack.com/authentication/token-types#bot';
  properties: INodeProperties[] = [
    {
      displayName: 'Bot Token',
      name: 'accessToken',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      placeholder: 'xoxb-...',
      description:
        'Bot User OAuth Token. Requires scopes: chat:write, assistant:write, im:history.',
    },
  ];

  authenticate: IAuthenticateGeneric = {
    type: 'generic',
    properties: {
      headers: {
        Authorization: '=Bearer {{$credentials.accessToken}}',
      },
    },
  };

  test: ICredentialTestRequest = {
    request: {
      baseURL: 'https://slack.com/api',
      url: '/auth.test',
      method: 'POST',
    },
  };
}
