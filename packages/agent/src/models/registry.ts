import type { ModelProfile } from './types';
import { getModelPriceRates } from './pricing';

export class ModelRegistry {
  private models: Map<string, ModelProfile> = new Map();

  constructor() {
    this.registerDefaults();
  }

  private registerDefaults() {
    // Helper to get rates from authoritative pricing table
    const getRates = (id: string) => getModelPriceRates(id);

    // OpenAI Models
    this.register({
      provider: 'openai',
      modelId: 'gpt-4o',
      capabilities: { reasoning: 9, coding: 9, debugging: 9, ui_generation: 8, vision: 9, speed: 6 },
      contextWindow: 128000,
      costInput: getRates('gpt-4o').inputPerMillion,
      costOutput: getRates('gpt-4o').outputPerMillion,
      tier: 'strong'
    });
    this.register({
      provider: 'openai',
      modelId: 'gpt-4o-mini',
      capabilities: { reasoning: 6, coding: 5, debugging: 5, ui_generation: 4, vision: 7, speed: 9 },
      contextWindow: 128000,
      costInput: getRates('gpt-4o-mini').inputPerMillion,
      costOutput: getRates('gpt-4o-mini').outputPerMillion,
      tier: 'fast'
    });

    // Google Models
    this.register({
      provider: 'google',
      modelId: 'gemini-3.5-flash-lite',
      capabilities: { reasoning: 6, coding: 6, debugging: 5, ui_generation: 5, vision: 7, speed: 10 },
      contextWindow: 1000000,
      costInput: getRates('gemini-3.5-flash-lite').inputPerMillion,
      costOutput: getRates('gemini-3.5-flash-lite').outputPerMillion,
      tier: 'fast'
    });
    this.register({
      provider: 'google',
      modelId: 'gemini-3.1-pro',
      capabilities: { reasoning: 9, coding: 9, debugging: 9, ui_generation: 8, vision: 9, speed: 6 },
      contextWindow: 2000000,
      costInput: getRates('gemini-3.1-pro').inputPerMillion,
      costOutput: getRates('gemini-3.1-pro').outputPerMillion,
      tier: 'strong'
    });
    this.register({
      provider: 'google',
      modelId: 'gemini-3.6-flash',
      capabilities: { reasoning: 7, coding: 6, debugging: 6, ui_generation: 5, vision: 8, speed: 9 },
      contextWindow: 1000000,
      costInput: getRates('gemini-3.6-flash').inputPerMillion,
      costOutput: getRates('gemini-3.6-flash').outputPerMillion,
      tier: 'fast'
    });
    this.register({
      provider: 'google',
      modelId: 'gemini-4-argon',
      capabilities: { reasoning: 10, coding: 9, debugging: 9, ui_generation: 8, vision: 9, speed: 7 },
      contextWindow: 2000000,
      costInput: getRates('gemini-4-argon').inputPerMillion,
      costOutput: getRates('gemini-4-argon').outputPerMillion,
      tier: 'strong'
    });

    // Anthropic Models (for future/completeness)
    this.register({
      provider: 'anthropic',
      modelId: 'claude-3-5-sonnet',
      capabilities: { reasoning: 10, coding: 10, debugging: 10, ui_generation: 9, vision: 8, speed: 7 },
      contextWindow: 200000,
      costInput: getRates('claude-3-5-sonnet').inputPerMillion,
      costOutput: getRates('claude-3-5-sonnet').outputPerMillion,
      tier: 'strong'
    });
  }

  register(profile: ModelProfile) {
    this.models.set(profile.modelId.toLowerCase(), profile);
  }

  get(modelId: string): ModelProfile | undefined {
    return this.models.get(modelId.toLowerCase());
  }

  findBestModel(provider: string, requirements: { minReasoning?: number; minCoding?: number; tier?: 'fast' | 'strong' | 'ultra' }): ModelProfile {
    const available = Array.from(this.models.values()).filter(m => m.provider === provider);
    if (available.length === 0) {
      throw new Error(`No models registered for provider: ${provider}`);
    }

    // Filter by tier first if specified
    let candidates = available;
    if (requirements.tier) {
      candidates = available.filter(m => m.tier === requirements.tier || (requirements.tier === 'strong' && m.tier === 'ultra'));
    }

    if (candidates.length === 0) candidates = available;

    // Sort by cheapest that meets capabilities
    candidates.sort((a, b) => {
      const costA = a.costInput + a.costOutput;
      const costB = b.costInput + b.costOutput;
      return costA - costB;
    });

    return candidates[0];
  }
}
