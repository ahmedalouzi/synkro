import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

const client = new SecretsManagerClient({ region: process.env.AWS_REGION || 'us-east-1' });

export interface ProductionSecrets {
  GOOGLE_API_KEY?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  DATABASE_URL?: string;
  LEMONSQUEEZY_WEBHOOK_SECRET?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  SYNKRO_SIGNING_ENC_KEY?: string;
  DOWNLOAD_TOKEN_SECRET?: string;
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  GITHUB_OAUTH_CLIENT_ID?: string;
  GITHUB_OAUTH_CLIENT_SECRET?: string;
  [key: string]: string | undefined;
}

export async function fetchProductionSecrets(): Promise<ProductionSecrets> {
  // AWS Secrets Manager only when asked for. The DigitalOcean server reads its secrets from .env, and calling AWS
  // there only logged an error at every boot.
  if (process.env.SYNKRO_SECRETS_SOURCE !== 'aws') {
    return {
      GOOGLE_API_KEY: process.env.GOOGLE_API_KEY || '',
      OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
      DATABASE_URL: process.env.DATABASE_URL || '',
      LEMONSQUEEZY_WEBHOOK_SECRET: process.env.LEMONSQUEEZY_WEBHOOK_SECRET || '',
      STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || '',
      DOWNLOAD_TOKEN_SECRET: process.env.DOWNLOAD_TOKEN_SECRET || '',
      GOOGLE_OAUTH_CLIENT_ID: process.env.GOOGLE_OAUTH_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || '',
      GOOGLE_OAUTH_CLIENT_SECRET: process.env.GOOGLE_OAUTH_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || '',
      GITHUB_OAUTH_CLIENT_ID: process.env.GITHUB_OAUTH_CLIENT_ID || process.env.GITHUB_CLIENT_ID || '',
      GITHUB_OAUTH_CLIENT_SECRET: process.env.GITHUB_OAUTH_CLIENT_SECRET || process.env.GITHUB_CLIENT_SECRET || '',
    };
  }

  try {
    const command = new GetSecretValueCommand({ SecretId: 'prod/synkro/backend-secrets' });
    const response = await client.send(command);
    if (response.SecretString) {
      return JSON.parse(response.SecretString);
    }
  } catch (error) {
    console.error('Failed to fetch AWS secrets:', error);
    // Graceful degradation or crash if secrets are strictly required
  }
  return {};
}
