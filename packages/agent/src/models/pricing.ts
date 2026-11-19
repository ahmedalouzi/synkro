/**
 * Authoritative Pricing Table & Credit Math for Synkro.
 * 
 * 1 credit = $0.002 real model cost ($1.00 = 500 credits).
 * Every request is priced deterministically so Synkro maintains profitability.
 */

export const CREDIT_UNIT_USD = 0.002;

export interface ModelPricingRate {
  inputPerMillion: number;
  cachedPerMillion: number;
  outputPerMillion: number;
}

export interface ModelPricingDefinition {
  base: ModelPricingRate;
  scheduled?: {
    effectiveFromIso: string;
    rate: ModelPricingRate;
  };
  tierOver200k?: ModelPricingRate;
  shutdownIso?: string;
  redirectToModel?: string;
}

export const MODEL_PRICING_TABLE: Record<string, ModelPricingDefinition> = {
  // Flash family (Google): Doubling on 2027-01-01
  'gemini-3.6-flash': {
    base: { inputPerMillion: 0.75, cachedPerMillion: 0.075, outputPerMillion: 3.75 },
    scheduled: {
      effectiveFromIso: '2027-01-01T00:00:00Z',
      rate: { inputPerMillion: 1.50, cachedPerMillion: 0.15, outputPerMillion: 7.50 },
    },
  },
  'gemini-3.8-flash': {
    base: { inputPerMillion: 0.75, cachedPerMillion: 0.075, outputPerMillion: 3.75 },
    scheduled: {
      effectiveFromIso: '2027-01-01T00:00:00Z',
      rate: { inputPerMillion: 1.50, cachedPerMillion: 0.15, outputPerMillion: 7.50 },
    },
  },
  'gemini-2.5-flash': {
    base: { inputPerMillion: 0.75, cachedPerMillion: 0.075, outputPerMillion: 3.75 },
    scheduled: {
      effectiveFromIso: '2027-01-01T00:00:00Z',
      rate: { inputPerMillion: 1.50, cachedPerMillion: 0.15, outputPerMillion: 7.50 },
    },
  },

  // Free plan workhorse & paid fallback
  'gemini-3.5-flash-lite': {
    base: { inputPerMillion: 0.30, cachedPerMillion: 0.03, outputPerMillion: 2.50 },
  },

  // Sunsetting on 2027-05-07 (redirects to gemini-3.5-flash-lite after shutdown)
  'gemini-3.1-flash-lite': {
    base: { inputPerMillion: 0.25, cachedPerMillion: 0.025, outputPerMillion: 1.50 },
    shutdownIso: '2027-05-07T00:00:00Z',
    redirectToModel: 'gemini-3.5-flash-lite',
  },

  // Pro family (Google): Tiered for >200k prompt tokens
  'gemini-3.1-pro': {
    base: { inputPerMillion: 2.00, cachedPerMillion: 0.20, outputPerMillion: 12.00 },
    tierOver200k: { inputPerMillion: 4.00, cachedPerMillion: 0.40, outputPerMillion: 18.00 },
  },
  'gemini-3.1-pro-preview': {
    base: { inputPerMillion: 2.00, cachedPerMillion: 0.20, outputPerMillion: 12.00 },
    tierOver200k: { inputPerMillion: 4.00, cachedPerMillion: 0.40, outputPerMillion: 18.00 },
  },
  'gemini-3-pro': {
    base: { inputPerMillion: 2.00, cachedPerMillion: 0.20, outputPerMillion: 12.00 },
    tierOver200k: { inputPerMillion: 4.00, cachedPerMillion: 0.40, outputPerMillion: 18.00 },
  },

  // Argon (Google): Doubling on 2026-12-01
  'gemini-4-argon': {
    base: { inputPerMillion: 2.00, cachedPerMillion: 0.10, outputPerMillion: 10.00 },
    scheduled: {
      effectiveFromIso: '2026-12-01T00:00:00Z',
      rate: { inputPerMillion: 4.00, cachedPerMillion: 0.20, outputPerMillion: 20.00 },
    },
  },

  // OpenAI Models
  'gpt-4o': {
    base: { inputPerMillion: 5.00, cachedPerMillion: 2.50, outputPerMillion: 15.00 },
  },
  'gpt-4o-mini': {
    base: { inputPerMillion: 0.15, cachedPerMillion: 0.075, outputPerMillion: 0.60 },
  },

  // Anthropic Models
  'claude-3-5-sonnet': {
    base: { inputPerMillion: 3.00, cachedPerMillion: 0.30, outputPerMillion: 15.00 },
  },
};

/**
 * Resolves the effective pricing rate for a given model, taking into account:
 * - Deprecations / sunset redirects (e.g. 2027-05-07 for 3.1-flash-lite)
 * - Scheduled price changes (e.g. 2027-01-01 for flash, 2026-12-01 for argon)
 * - Token length tiers (e.g. >200k prompt tokens for gemini-3.1-pro)
 */
export function resolveModelPricing(
  modelId: string,
  options?: { promptTokens?: number; now?: Date }
): { modelId: string; rates: ModelPricingRate } {
  const now = options?.now || new Date();
  const promptTokens = options?.promptTokens ?? 0;
  const normalizedId = modelId.toLowerCase().trim();

  let entry = MODEL_PRICING_TABLE[normalizedId];
  let resolvedModel = normalizedId;

  // Check if model has sunset and redirects
  if (entry?.shutdownIso && entry.redirectToModel) {
    if (now.getTime() >= new Date(entry.shutdownIso).getTime()) {
      resolvedModel = entry.redirectToModel;
      entry = MODEL_PRICING_TABLE[resolvedModel];
    }
  }

  if (!entry) {
    // Default safe fallback if model not explicitly in table
    return {
      modelId: resolvedModel,
      rates: { inputPerMillion: 0.75, cachedPerMillion: 0.075, outputPerMillion: 3.75 },
    };
  }

  // Check >200k prompt tokens tier
  if (promptTokens > 200_000 && entry.tierOver200k) {
    return {
      modelId: resolvedModel,
      rates: entry.tierOver200k,
    };
  }

  // Check scheduled price changes
  if (entry.scheduled && now.getTime() >= new Date(entry.scheduled.effectiveFromIso).getTime()) {
    return {
      modelId: resolvedModel,
      rates: entry.scheduled.rate,
    };
  }

  return {
    modelId: resolvedModel,
    rates: entry.base,
  };
}

/**
 * Convenience helper returning just the effective ModelPricingRate for a given model.
 */
export function getModelPriceRates(
  modelId: string,
  options?: { promptTokens?: number; now?: Date }
): ModelPricingRate {
  return resolveModelPricing(modelId, options).rates;
}

export interface TokenUsageInput {
  inputTokens: number;
  cachedTokens?: number;
  outputTokens: number;
  thinkingTokens?: number;
}

export interface ExplicitModelRates {
  modelId?: string;
  costInputPerMillion?: number;
  costOutputPerMillion?: number;
  costCachedPerMillion?: number;
  inputPerMillion?: number;
  outputPerMillion?: number;
  cachedPerMillion?: number;
}

/**
 * Calculates model real dollar cost according to the official formula:
 * cost_usd = ((inputTokens - cachedTokens) * p_in + cachedTokens * p_cache + (outputTokens + thinkingTokens) * p_out) / 10^6
 */
export function calculateModelCostUsd(
  modelIdOrRates: string | ExplicitModelRates,
  usage: TokenUsageInput,
  now?: Date
): number {
  const inputTokens = Math.max(0, usage.inputTokens || 0);
  const cachedTokens = Math.min(inputTokens, Math.max(0, usage.cachedTokens || 0));
  const uncachedInput = Math.max(0, inputTokens - cachedTokens);
  const outputTokens = Math.max(0, usage.outputTokens || 0);
  const thinkingTokens = Math.max(0, usage.thinkingTokens || 0);
  const billableOutput = outputTokens + thinkingTokens;

  let pIn = 0;
  let pCache = 0;
  let pOut = 0;

  if (typeof modelIdOrRates === 'string') {
    const normalized = modelIdOrRates.toLowerCase().trim();
    if (MODEL_PRICING_TABLE[normalized]) {
      const resolved = resolveModelPricing(normalized, { promptTokens: inputTokens, now });
      pIn = resolved.rates.inputPerMillion;
      pCache = resolved.rates.cachedPerMillion;
      pOut = resolved.rates.outputPerMillion;
    } else {
      // Fallback for string not in table
      pIn = 0.75;
      pCache = 0.075;
      pOut = 3.75;
    }
  } else {
    // Explicit rates provided or object with modelId
    const explicitObj = modelIdOrRates as ExplicitModelRates;
    const modelKey = explicitObj.modelId ? explicitObj.modelId.toLowerCase().trim() : '';
    if (modelKey && MODEL_PRICING_TABLE[modelKey]) {
      const resolved = resolveModelPricing(modelKey, { promptTokens: inputTokens, now });
      pIn = resolved.rates.inputPerMillion;
      pCache = resolved.rates.cachedPerMillion;
      pOut = resolved.rates.outputPerMillion;
    } else if (explicitObj.costInputPerMillion !== undefined || explicitObj.inputPerMillion !== undefined) {
      pIn = explicitObj.costInputPerMillion ?? explicitObj.inputPerMillion ?? 0;
      pOut = explicitObj.costOutputPerMillion ?? explicitObj.outputPerMillion ?? 0;
      pCache = explicitObj.costCachedPerMillion ?? explicitObj.cachedPerMillion ?? (pIn * 0.1);
    } else {
      pIn = 0.75;
      pCache = 0.075;
      pOut = 3.75;
    }
  }

  const costUsd = (uncachedInput * pIn + cachedTokens * pCache + billableOutput * pOut) / 1_000_000;
  return Math.round(costUsd * 100_000_000) / 100_000_000; // 8 decimal places precision
}

/**
 * Converts real USD cost to integer credits:
 * 1 credit = $0.002
 * credits = max(1, ceil(costUsd / 0.002))
 * 
 * If costUsd <= 0 and totalTokens === 0, returns 0.
 */
export function costUsdToCredits(costUsd: number, totalTokens = 0): number {
  if (costUsd <= 0 && totalTokens === 0) {
    return 0;
  }
  return Math.max(1, Math.ceil(costUsd / CREDIT_UNIT_USD));
}
