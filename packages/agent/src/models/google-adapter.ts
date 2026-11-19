import type {
  AIRequest,
  AIResponse,
  AIStreamEvent,
} from '@peep/shared';
import { createHash } from 'node:crypto';
import type { ProviderAdapter } from './types';
import { classifyProviderError } from './error-classifier';
import { calculateModelCostUsd, costUsdToCredits } from './pricing';

const contextCacheRegistry = new Map<string, { resourceName: string; expireTimeMs: number }>();

export class GoogleGeminiAdapter implements ProviderAdapter {
  readonly id = 'google';

  constructor(private apiKey?: string) {}

  private availableModelsPromise: Promise<string[]> | null = null;

  async estimateCost(_request: import('@peep/shared').AIRequest): Promise<import('@peep/shared').CostEstimate> {
    return { cost: 0, currency: 'USD' };
  }

  getContextLimit(_tier: import('@peep/shared').CapabilityTier): number {
    return 1000000; // Gemini Flash limit
  }

  /**
   * Explicit helper for Gemini Context Caching.
   * Callers can invoke this to create a cached content resource on Google's API,
   * which can then be passed to requests as `cachedContent`.
   */
  async createContextCache(options: {
    model: string;
    contents: any[];
    systemInstruction?: any;
    ttlSeconds?: number;
  }): Promise<{ name: string; expireTime: string }> {
    if (!this.apiKey) throw new Error('GOOGLE_API_KEY is not configured');
    const url = `https://generativelanguage.googleapis.com/v1beta/cachedContents?key=${this.apiKey}`;
    const ttlSeconds = options.ttlSeconds || 3600;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: `models/${options.model}`,
        contents: options.contents,
        systemInstruction: options.systemInstruction,
        ttl: `${ttlSeconds}s`,
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Failed to create context cache: ${res.status} - ${errText}`);
    }
    return await res.json();
  }

  /**
   * Resolves or creates a cached content resource keyed by sha256(model + systemPrompt + projectContext).
   * Reuses the resource name across repeated turns in the same session.
   */
  async getOrCreateContextCache(options: {
    model: string;
    systemPrompt: string;
    projectContext?: string;
    ttlSeconds?: number;
  }): Promise<string> {
    const ttlSeconds = options.ttlSeconds || 300;
    const keySource = `${options.model}:${options.systemPrompt}:${options.projectContext || ''}`;
    const hash = createHash('sha256').update(keySource).digest('hex');
    const now = Date.now();

    const cached = contextCacheRegistry.get(hash);
    if (cached && cached.expireTimeMs > now + 10_000) {
      return cached.resourceName;
    }

    const contents = options.projectContext
      ? [{ role: 'user', parts: [{ text: options.projectContext }] }]
      : [];
    const systemInstruction = options.systemPrompt
      ? { parts: [{ text: options.systemPrompt }] }
      : undefined;

    const res = await this.createContextCache({
      model: options.model,
      contents,
      systemInstruction,
      ttlSeconds,
    });

    const expireTimeMs = res.expireTime ? new Date(res.expireTime).getTime() : (now + ttlSeconds * 1000);
    contextCacheRegistry.set(hash, { resourceName: res.name, expireTimeMs });
    return res.name;
  }

  private getAvailableModels(): Promise<string[]> {
    if (!this.availableModelsPromise) {
      this.availableModelsPromise = (async () => {
        try {
          const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${this.apiKey}`;
          const res = await fetch(url);
          if (!res.ok) {
            throw new Error(`Failed to list models: ${res.statusText}`);
          }
          const data = await res.json();
          const list = data?.models?.map((m: any) => m.name.replace('models/', '')) || [];
          console.log('[GoogleGeminiAdapter] Fetched available models:', list);
          return list;
        } catch (err) {
          console.error('[GoogleGeminiAdapter] Failed to fetch models list, using defaults:', err);
          this.availableModelsPromise = null; // Retry next time
          return [
            'gemini-3.6-flash',
            'gemini-3.1-pro-preview',
            'gemini-2.5-flash',
            'gemini-3.5-flash-lite',
          ];
        }
      })();
    }
    return this.availableModelsPromise;
  }

  private async resolveModelId(modelId: string): Promise<string> {
    const available = await this.getAvailableModels();
    const lowerRequested = modelId.toLowerCase();

    // 1. If requested model is exactly supported (case-insensitive), return it
    const exactMatch = available.find(m => m.toLowerCase() === lowerRequested);
    if (exactMatch) {
      return exactMatch;
    }

    // 2. Map suffix of the fictitious model IDs
    if (lowerRequested === 'gemini-3.1-pro') {
      const match = available.find(m => m.toLowerCase() === 'gemini-3.1-pro-preview');
      if (match) return match;
    }

    // 3. Identify if request is for a "Pro" model
    const isPro = lowerRequested.includes('pro') || 
                  lowerRequested.includes('strong') || 
                  lowerRequested.includes('opus') || 
                  lowerRequested.includes('sonnet') || 
                  lowerRequested.includes('gpt-4o') || 
                  lowerRequested.includes('ultra') || 
                  lowerRequested.includes('o1') || 
                  lowerRequested.includes('o3') || 
                  lowerRequested.includes('reasoning') ||
                  lowerRequested.includes('premium');
    const isMini = lowerRequested.includes('-mini') || lowerRequested.includes('haiku') || lowerRequested.includes('flash');

    const targetType = (isPro && !isMini) ? 'pro' : 'flash';

    // 4. Filter available models by type ('pro' or 'flash')
    const candidates = available.filter(m => {
      const lowerM = m.toLowerCase();
      if (targetType === 'pro') {
        return lowerM.includes('pro') && !lowerM.includes('embed') && !lowerM.includes('imagen') && !lowerM.includes('veo');
      } else {
        return lowerM.includes('flash') && !lowerM.includes('embed') && !lowerM.includes('imagen') && !lowerM.includes('veo');
      }
    });

    if (candidates.length > 0) {
      // Sort candidates by parsed version number in descending order
      candidates.sort((a, b) => {
        const getVer = (name: string) => {
          const match = name.match(/gemini-(\d+(?:\.\d+)?)/);
          return match ? parseFloat(match[1]) : 0;
        };
        return getVer(b) - getVer(a);
      });
      return candidates[0];
    }

    // Fallbacks if no direct matches found
    if (targetType === 'pro') {
      const fallbackPro = available.find(m => m.toLowerCase().includes('pro'));
      if (fallbackPro) return fallbackPro;
    }
    const fallbackFlash = available.find(m => m.toLowerCase().includes('flash'));
    if (fallbackFlash) return fallbackFlash;

    return available[0] || 'gemini-3.6-flash';
  }

  private mapMessages(messages: any[]): { contents: any[]; systemInstruction?: any } {
    let systemInstruction: any = undefined;
    const contents: any[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === 'system') {
        systemInstruction = { parts: [{ text: msg.content }] };
      } else if (msg.role === 'user') {
        contents.push({
          role: 'user',
          parts: [
            { text: msg.content },
            ...(msg.images ?? []).map((img: { mimeType: string; data: string }) => ({ inlineData: { mimeType: img.mimeType, data: img.data } })),
          ],
        });
      } else if (msg.role === 'assistant') {
        const parts: any[] = [];
        if (msg.content) parts.push({ text: msg.content });
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            let args = {};
            try { args = JSON.parse(tc.function.arguments); } catch {}
            let thoughtSignature = '';
            let id = tc.id;
            try {
              const parsed = JSON.parse(tc.id);
              if (parsed.thoughtSignature) thoughtSignature = parsed.thoughtSignature;
              if (parsed.id) id = parsed.id;
            } catch {}
            
            const part: any = { functionCall: { name: tc.function.name, args, id } };
            if (thoughtSignature) part.thoughtSignature = thoughtSignature;
            parts.push(part);
          }
        }
        contents.push({ role: 'model', parts });
      } else if (msg.role === 'tool') {
        let id = msg.tool_call_id;
        try {
          const parsed = JSON.parse(id);
          if (parsed.id) id = parsed.id;
        } catch {}

        const parts = [{
          functionResponse: {
            name: msg.name,
            response: { name: msg.name, content: msg.content },
            id
          }
        }];
        
        while (i + 1 < messages.length && messages[i + 1].role === 'tool') {
          const nextMsg = messages[i + 1];
          let nextId = nextMsg.tool_call_id;
          try {
            const parsed = JSON.parse(nextId);
            if (parsed.id) nextId = parsed.id;
          } catch {}
          
          parts.push({
            functionResponse: {
              name: nextMsg.name,
              response: { name: nextMsg.name, content: nextMsg.content },
              id: nextId
            }
          });
          i++;
        }
        
        contents.push({ role: 'user', parts });
      }
    }
    const consolidatedContents: any[] = [];
    for (const content of contents) {
      if (consolidatedContents.length > 0 && consolidatedContents[consolidatedContents.length - 1].role === content.role) {
        consolidatedContents[consolidatedContents.length - 1].parts.push(...content.parts);
      } else {
        consolidatedContents.push(content);
      }
    }

    return { contents: consolidatedContents, systemInstruction };
  }

  private mapTools(tools: any[] | undefined): any[] | undefined {
    if (!tools || tools.length === 0) return undefined;
    const functionDeclarations = tools
      .filter(t => t.type === 'function')
      .map(t => ({
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters
      }));
    if (functionDeclarations.length === 0) return undefined;
    return [{ functionDeclarations }];
  }

  async generate(request: AIRequest, options?: { signal?: AbortSignal; resolvedModelId?: string; latencyOut?: any }): Promise<AIResponse> {
    if (!this.apiKey) throw new Error('GOOGLE_API_KEY is not configured');
    
    const rawModel = options?.resolvedModelId || 'gemini-3.6-flash';
    const listStart = Date.now();
    const modelId = await this.resolveModelId(rawModel);
    const listEnd = Date.now();
    if (options?.latencyOut) {
      options.latencyOut.listModelsDuration = listEnd - listStart;
    }
    
    console.log(`[GoogleGeminiAdapter] [generate] Original requested model: ${rawModel} -> Normalized: ${modelId}`);
    const { contents, systemInstruction } = this.mapMessages(request.messages);
    const tools = this.mapTools(request.tools);

    const payload: any = { contents };
    if (systemInstruction) payload.systemInstruction = systemInstruction;
    if (tools) payload.tools = tools;
    if ((request as any).cachedContent) {
      payload.cachedContent = (request as any).cachedContent;
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${this.apiKey}`;
    console.log(`[GoogleGeminiAdapter] [generate] Sending POST request to: https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`);
    console.log(`[GoogleGeminiAdapter] [generate] Headers: Content-Type=application/json`);
    console.log(`[GoogleGeminiAdapter] [generate] Payload summary: ${JSON.stringify({ systemInstruction: systemInstruction ? 'present' : 'none', tools: tools ? 'present' : 'none', messageCount: contents.length })}`);
    
    console.log(`[GoogleGeminiAdapter] [generate] Tools declaration:`, JSON.stringify(tools, null, 2));

    const apiStart = Date.now();
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: options?.signal
    });
    const apiEnd = Date.now();
    if (options?.latencyOut) {
      options.latencyOut.geminiCallDuration = apiEnd - apiStart;
    }

    if (!response.ok) {
      const errBody = await response.text();
      console.error(`[GoogleGeminiAdapter] [generate] Gemini API returned error status: ${response.status} ${response.statusText}`);
      console.error(`[GoogleGeminiAdapter] [generate] Gemini API error response body:`, errBody);
      throw classifyProviderError(new Error(`Gemini API error: ${response.status} ${response.statusText} - ${errBody}`), response.status);
    }

    const data = await response.json();
    
    const result: AIResponse = { content: '' };
    
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const toolCalls: any[] = [];
    
    for (const p of parts) {
      if (p.text) result.content += p.text;
      if (p.functionCall) {
        const rawId = p.functionCall.id || p.id || 'call_' + Math.random().toString(36).substring(2);
        const combinedId = JSON.stringify({ id: rawId, thoughtSignature: p.thoughtSignature || '' });
        toolCalls.push({
          id: combinedId,
          name: p.functionCall.name,
          arguments: p.functionCall.args || {}
        });
      }
    }
    
    if (toolCalls.length > 0) {
      result.toolCalls = toolCalls;
    }

    // Extract real Gemini usageMetadata & calculate credit cost
    const usageMeta = data?.usageMetadata;
    const inputTokens = usageMeta?.promptTokenCount ?? Math.ceil(JSON.stringify(request.messages).length / 4);
    const cachedTokens = usageMeta?.cachedContentTokenCount ?? 0;
    const outputTokens = usageMeta?.candidatesTokenCount ?? Math.ceil((result.content?.length ?? 0) / 4);
    const thinkingTokens = usageMeta?.thoughtsTokenCount ?? 0;
    const totalTokens = usageMeta?.totalTokenCount ?? (inputTokens + outputTokens + thinkingTokens);

    const costUsd = calculateModelCostUsd(modelId, { inputTokens, cachedTokens, outputTokens, thinkingTokens });
    const credits = costUsdToCredits(costUsd, totalTokens);

    result.usage = {
      inputTokens,
      outputTokens,
      totalTokens,
      cachedTokens,
      thinkingTokens,
    } as any;

    result.cost = {
      cost: costUsd,
      currency: 'USD',
      credits,
    } as any;
    
    return result;
  }

  async *stream(request: AIRequest, options?: { signal?: AbortSignal; resolvedModelId?: string; latencyOut?: any }): AsyncIterable<AIStreamEvent> {
    if (!this.apiKey) throw new Error('GOOGLE_API_KEY is not configured');
    
    const rawModel = options?.resolvedModelId || 'gemini-3.6-flash';
    const listStart = Date.now();
    const modelId = await this.resolveModelId(rawModel);
    const listEnd = Date.now();
    if (options?.latencyOut) {
      options.latencyOut.listModelsDuration = listEnd - listStart;
    }
    
    console.log(`[GoogleGeminiAdapter] [stream] Original requested model: ${rawModel} -> Normalized: ${modelId}`);
    const { contents, systemInstruction } = this.mapMessages(request.messages);
    const tools = this.mapTools(request.tools);

    const payload: any = { contents };
    if (systemInstruction) payload.systemInstruction = systemInstruction;
    if (tools) payload.tools = tools;
    if ((request as any).cachedContent) {
      payload.cachedContent = (request as any).cachedContent;
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:streamGenerateContent?alt=sse&key=${this.apiKey}`;
    console.log(`[GoogleGeminiAdapter] [stream] Sending POST stream request to: https://generativelanguage.googleapis.com/v1beta/models/${modelId}:streamGenerateContent`);
    console.log(`[GoogleGeminiAdapter] [stream] Headers: Content-Type=application/json`);
    console.log(`[GoogleGeminiAdapter] [stream] Payload summary: ${JSON.stringify({ systemInstruction: systemInstruction ? 'present' : 'none', tools: tools ? 'present' : 'none', messageCount: contents.length })}`);
    
    console.log(`[GoogleGeminiAdapter] [stream] Tools declaration:`, JSON.stringify(tools, null, 2));

    const apiStart = Date.now();
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: options?.signal
    });
    const apiEnd = Date.now();
    if (options?.latencyOut) {
      options.latencyOut.geminiCallDuration = apiEnd - apiStart;
    }

    if (!response.ok) {
      const errBody = await response.text();
      console.error(`[GoogleGeminiAdapter] [stream] Gemini API returned error status: ${response.status} ${response.statusText}`);
      console.error(`[GoogleGeminiAdapter] [stream] Gemini API error response body:`, errBody);
      throw classifyProviderError(new Error(`Gemini API error: ${response.status} ${response.statusText} - ${errBody}`), response.status);
    }

    if (!response.body) throw new Error('Empty response body');

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let lastUsageMetadata: any = null;
    let accumulatedContentLength = 0;

    while (true) {
      if (options?.signal?.aborted) throw new Error('Aborted');
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data: ')) {
          const dataStr = trimmed.slice(6);
          if (dataStr === '[DONE]') continue;
          
          let data;
          try { data = JSON.parse(dataStr); } catch { continue; }

          if (data?.usageMetadata) {
            lastUsageMetadata = data.usageMetadata;
          }
          
          const parts = data?.candidates?.[0]?.content?.parts || [];
          for (const part of parts) {
            if (part?.text) {
              accumulatedContentLength += part.text.length;
              yield { type: 'delta', content: part.text };
            }
            if (part?.functionCall) {
              const rawId = part.functionCall.id || part.id || 'call_' + Math.random().toString(36).substring(2);
              const combinedId = JSON.stringify({ id: rawId, thoughtSignature: part.thoughtSignature || '' });
              yield {
                type: 'tool_call',
                toolCall: {
                  id: combinedId,
                  name: part.functionCall.name,
                  arguments: part.functionCall.args || {}
                }
              };
            }
          }
        }
      }
    }

    const inputTokens = lastUsageMetadata?.promptTokenCount ?? Math.ceil(JSON.stringify(request.messages).length / 4);
    const cachedTokens = lastUsageMetadata?.cachedContentTokenCount ?? 0;
    const outputTokens = lastUsageMetadata?.candidatesTokenCount ?? Math.ceil(accumulatedContentLength / 4);
    const thinkingTokens = lastUsageMetadata?.thoughtsTokenCount ?? 0;
    const totalTokens = lastUsageMetadata?.totalTokenCount ?? (inputTokens + outputTokens + thinkingTokens);

    const costUsd = calculateModelCostUsd(modelId, { inputTokens, cachedTokens, outputTokens, thinkingTokens });
    const credits = costUsdToCredits(costUsd, totalTokens);

    yield {
      type: 'done',
      usage: {
        inputTokens,
        outputTokens,
        totalTokens,
        cachedTokens,
        thinkingTokens,
      } as any,
      cost: {
        cost: costUsd,
        currency: 'USD',
        credits,
      } as any,
    };
  }
}
