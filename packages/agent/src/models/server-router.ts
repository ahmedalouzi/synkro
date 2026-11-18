import type { ModelTier } from '@peep/shared';
import { getModelPriceRates } from './pricing';

export interface ServerModelConfig {
  providerId: string;
  modelId: string;
  maxTokens: number;
  temperature: number;
  costInputPerMillion: number;
  costOutputPerMillion: number;
  costCachedPerMillion?: number;
  fallback?: {
    providerId: string;
    modelId: string;
    costInputPerMillion?: number;
    costOutputPerMillion?: number;
  };
  geminiFallback?: {
    providerId: string;
    modelId: string;
    costInputPerMillion: number;
    costOutputPerMillion: number;
  };
}

export interface RouteOptions {
  outOfCreditsFallback?: boolean;
  hasOpenAiKey?: boolean;
  now?: Date;
}

export class ServerModelRouter {
  private buildFallback(providerId: string, modelId: string, now?: Date) {
    const rates = getModelPriceRates(modelId, { now });
    return {
      providerId,
      modelId,
      costInputPerMillion: rates.inputPerMillion,
      costOutputPerMillion: rates.outputPerMillion,
    };
  }

  private getTierBase(tier: ModelTier, now?: Date): ServerModelConfig {
    if (tier === 'fast') {
      const rates = getModelPriceRates('gemini-3.6-flash', { now });
      return {
        providerId: 'google',
        modelId: 'gemini-3.6-flash',
        maxTokens: 4096,
        temperature: 0.2,
        costInputPerMillion: rates.inputPerMillion,
        costOutputPerMillion: rates.outputPerMillion,
        costCachedPerMillion: rates.cachedPerMillion,
        fallback: this.buildFallback('openai', 'gpt-4o-mini', now),
        geminiFallback: this.buildFallback('google', 'gemini-3.5-flash-lite', now),
      };
    }
    if (tier === 'reasoning') {
      const rates = getModelPriceRates('gpt-4o', { now });
      return {
        providerId: 'openai',
        modelId: 'gpt-4o',
        maxTokens: 8192,
        temperature: 0.0,
        costInputPerMillion: rates.inputPerMillion,
        costOutputPerMillion: rates.outputPerMillion,
        costCachedPerMillion: rates.cachedPerMillion,
        fallback: this.buildFallback('google', 'gemini-3.6-flash', now),
        geminiFallback: this.buildFallback('google', 'gemini-3.6-flash', now),
      };
    }
    if (tier === 'premium') {
      const rates = getModelPriceRates('gemini-3.1-pro', { now });
      return {
        providerId: 'google',
        modelId: 'gemini-3.1-pro',
        maxTokens: 8192,
        temperature: 0.3,
        costInputPerMillion: rates.inputPerMillion,
        costOutputPerMillion: rates.outputPerMillion,
        costCachedPerMillion: rates.cachedPerMillion,
        fallback: this.buildFallback('openai', 'gpt-4o', now),
        geminiFallback: this.buildFallback('google', 'gemini-3.6-flash', now),
      };
    }
    throw new Error(`Unsupported model tier: ${tier}`);
  }

  /**
   * Resolves fallback config for a tier, taking into account whether an OpenAI key is configured.
   */
  resolveFallbackConfig(tier: ModelTier, hasOpenAiKey = Boolean(process.env.OPENAI_API_KEY), now?: Date) {
    const config = this.getTierBase(tier, now);
    if (!hasOpenAiKey && config.fallback?.providerId === 'openai' && config.geminiFallback) {
      return config.geminiFallback;
    }
    return config.fallback;
  }

  route(tier: ModelTier, plan = 'pro', manualModel?: string, options?: RouteOptions): ServerModelConfig {
    const now = options?.now;
    const baseConfig = this.getTierBase(tier, now);

    // Plan boundary checking
    if (tier === 'premium' && plan === 'free') {
      throw new Error('Premium tier requires a paid active subscription plan.');
    }

    const hasOpenAiKey = options?.hasOpenAiKey ?? Boolean(process.env.OPENAI_API_KEY);

    // Free plan or out-of-credits fallback: route fast tier to gemini-3.5-flash-lite
    if (tier === 'fast' && (plan === 'free' || options?.outOfCreditsFallback === true)) {
      const liteRates = getModelPriceRates('gemini-3.5-flash-lite', { now });
      return {
        providerId: 'google',
        modelId: 'gemini-3.5-flash-lite',
        maxTokens: 4096,
        temperature: 0.2,
        costInputPerMillion: liteRates.inputPerMillion,
        costOutputPerMillion: liteRates.outputPerMillion,
        costCachedPerMillion: liteRates.cachedPerMillion,
        fallback: this.resolveFallbackConfig(tier, hasOpenAiKey, now),
        geminiFallback: baseConfig.geminiFallback,
      };
    }

    const effectiveFallback = (!hasOpenAiKey && baseConfig.fallback?.providerId === 'openai' && baseConfig.geminiFallback)
      ? baseConfig.geminiFallback
      : baseConfig.fallback;

    if (manualModel) {
      let providerId = 'openai';
      if (manualModel.startsWith('gemini')) providerId = 'google';
      if (manualModel.startsWith('claude')) providerId = 'anthropic';
      const manualRates = getModelPriceRates(manualModel, { now });
      return {
        ...baseConfig,
        providerId,
        modelId: manualModel,
        costInputPerMillion: manualRates.inputPerMillion,
        costOutputPerMillion: manualRates.outputPerMillion,
        costCachedPerMillion: manualRates.cachedPerMillion,
        fallback: effectiveFallback,
      };
    }

    // If reasoning tier is requested when OPENAI_API_KEY is absent, fall back to Gemini with Gemini pricing
    if (tier === 'reasoning' && !hasOpenAiKey && baseConfig.geminiFallback) {
      const gemRates = getModelPriceRates(baseConfig.geminiFallback.modelId, { now });
      return {
        ...baseConfig,
        providerId: baseConfig.geminiFallback.providerId,
        modelId: baseConfig.geminiFallback.modelId,
        costInputPerMillion: gemRates.inputPerMillion,
        costOutputPerMillion: gemRates.outputPerMillion,
        costCachedPerMillion: gemRates.cachedPerMillion,
        fallback: baseConfig.geminiFallback,
      };
    }

    return {
      ...baseConfig,
      fallback: effectiveFallback,
    };
  }
}
