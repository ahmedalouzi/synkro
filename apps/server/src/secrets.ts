import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

const client = new SecretsManagerClient({ region: process.env.AWS_REGION || 'us-east-1' });

export async function fetchProductionSecrets(): Promise<Record<string, string>> {
  if (process.env.NODE_ENV !== 'production') {
    // In dev/staging, fallback to env vars or dev secrets
    return {
      GOOGLE_API_KEY: process.env.GOOGLE_API_KEY || '',
      OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
      DATABASE_URL: process.env.DATABASE_URL || '',
      LEMONSQUEEZY_WEBHOOK_SECRET: process.env.LEMONSQUEEZY_WEBHOOK_SECRET || '',
      STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || '',
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
