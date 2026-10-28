import type {
  AIRequest,
  AIResponse,
  AIStreamEvent,
  CostEstimate,
  AIError,
  CapabilityTier
} from '@peep/shared';
import { randomUUID } from 'node:crypto';

import { type ProviderAdapter } from './types';
export { type ProviderAdapter };


export class MockOpenAIAdapter implements ProviderAdapter {
  readonly id = 'openai';

  async generate(request: AIRequest, options?: { signal?: AbortSignal }): Promise<AIResponse> {
    if (options?.signal?.aborted) {
      throw new Error('Provider request aborted');
    }
    return {
      content: `[OpenAI Backend] Response for prompt: ${JSON.stringify(request.messages)}`,
      usage: { inputTokens: 5, outputTokens: 10, totalTokens: 15 },
      cost: { cost: 0.0001, currency: 'USD' }
    };
  }

  async *stream(_request: AIRequest, options?: { signal?: AbortSignal }): AsyncIterable<AIStreamEvent> {
    if (options?.signal?.aborted) {
      throw new Error('Provider request aborted');
    }
    const chunks = ['[OpenAI ', 'Backend] ', 'streaming ', 'response.'];
    for (const chunk of chunks) {
      if (options?.signal?.aborted) {
        throw new Error('Provider request aborted');
      }
      yield { type: 'delta', content: chunk };
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    yield {
      type: 'done',
      usage: { inputTokens: 5, outputTokens: 10, totalTokens: 15 },
      cost: { cost: 0.0001, currency: 'USD' }
    };
  }
}

export class OpenAIAdapter implements ProviderAdapter {
  readonly id = 'openai';
  constructor(private apiKey: string) {}

  async generate(request: AIRequest, options?: { signal?: AbortSignal; resolvedModelId?: string }): Promise<AIResponse> {
    const modelId = options?.resolvedModelId || 'gpt-4o-mini';
    const payload = {
      model: modelId,
      messages: request.messages.map(m => {
        const mapped: any = { role: m.role, content: m.content || '' };
        if (m.role === 'user' && m.images?.length) {
          mapped.content = [
            { type: 'text', text: m.content || '' },
            ...m.images.map((img: { mimeType: string; data: string }) => ({
              type: 'image_url',
              image_url: { url: `data:${img.mimeType};base64,${img.data}` },
            })),
          ];
        }
        if (m.tool_calls) mapped.tool_calls = m.tool_calls;
        if (m.tool_call_id) mapped.tool_call_id = m.tool_call_id;
        if (m.name) mapped.name = m.name;
        return mapped;
      }),
      tools: request.tools,
      temperature: 0.2
    };
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(payload),
      signal: options?.signal
    });
    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${errBody}`);
    }
    const data = await response.json();
    const message = data?.choices?.[0]?.message;
    const result: AIResponse = { content: message?.content || '' };
    if (message?.tool_calls) {
      result.toolCalls = message.tool_calls.map((tc: any) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments
      }));
    }
    return result;
  }

  async *stream(request: AIRequest, options?: { signal?: AbortSignal; resolvedModelId?: string }): AsyncIterable<AIStreamEvent> {
    const modelId = options?.resolvedModelId || 'gpt-4o-mini';
    const payload = {
      model: modelId,
      messages: request.messages.map(m => {
        const mapped: any = { role: m.role, content: m.content || '' };
        if (m.role === 'user' && m.images?.length) {
          mapped.content = [
            { type: 'text', text: m.content || '' },
            ...m.images.map((img: { mimeType: string; data: string }) => ({
              type: 'image_url',
              image_url: { url: `data:${img.mimeType};base64,${img.data}` },
            })),
          ];
        }
        if (m.tool_calls) mapped.tool_calls = m.tool_calls;
        if (m.tool_call_id) mapped.tool_call_id = m.tool_call_id;
        if (m.name) mapped.name = m.name;
        return mapped;
      }),
      tools: request.tools,
      stream: true,
      temperature: 0.2
    };
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(payload),
      signal: options?.signal
    });
    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${errBody}`);
    }
    if (!response.body) throw new Error('Empty response body');
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    const toolCallsMap = new Map<number, any>();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const cleaned = line.trim();
        if (!cleaned || cleaned === 'data: [DONE]') continue;
        if (cleaned.startsWith('data: ')) {
          try {
            const data = JSON.parse(cleaned.slice(6));
            const delta = data?.choices?.[0]?.delta;
            if (delta?.content) {
              yield { type: 'delta', content: delta.content };
            }
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (!toolCallsMap.has(tc.index)) {
                  toolCallsMap.set(tc.index, { id: tc.id, name: tc.function?.name || '', arguments: tc.function?.arguments || '' });
                } else {
                  const existing = toolCallsMap.get(tc.index);
                  if (tc.id) existing.id = tc.id;
                  if (tc.function?.name) existing.name += tc.function.name;
                  if (tc.function?.arguments) existing.arguments += tc.function.arguments;
                }
              }
            }
          } catch {}
        }
      }
    }
    for (const tc of toolCallsMap.values()) {
      let args = {};
      try { args = JSON.parse(tc.arguments); } catch {}
      yield { type: 'tool_call', toolCall: { id: tc.id, name: tc.name, arguments: args } };
    }
    yield { type: 'done' };
  }
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly id = 'anthropic';
  constructor(private apiKey: string) {}

  private mapMessages(messages: any[]): { system?: string; messages: any[] } {
    let system: string | undefined = undefined;
    const mapped: any[] = [];
    for (const m of messages) {
      if (m.role === 'system') {
        system = m.content;
      } else {
        mapped.push({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: m.role === 'user' && m.images?.length
            ? [
                ...m.images.map((img: { mimeType: string; data: string }) => ({
                  type: 'image',
                  source: { type: 'base64', media_type: img.mimeType, data: img.data },
                })),
                { type: 'text', text: m.content || '' },
              ]
            : m.content
        });
      }
    }
    return { system, messages: mapped };
  }

  async generate(request: AIRequest, options?: { signal?: AbortSignal; resolvedModelId?: string }): Promise<AIResponse> {
    const modelId = options?.resolvedModelId || 'claude-3-5-sonnet-20241022';
    const { system, messages } = this.mapMessages(request.messages);
    const payload = {
      model: modelId,
      messages,
      system,
      max_tokens: 4096,
      temperature: 0.2
    };
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(payload),
      signal: options?.signal
    });
    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`Anthropic API error: ${response.status} - ${errBody}`);
    }
    const data = await response.json();
    const contentText = data?.content?.[0]?.text || '';
    return { content: contentText };
  }

  async *stream(request: AIRequest, options?: { signal?: AbortSignal; resolvedModelId?: string }): AsyncIterable<AIStreamEvent> {
    const modelId = options?.resolvedModelId || 'claude-3-5-sonnet-20241022';
    const { system, messages } = this.mapMessages(request.messages);
    const payload = {
      model: modelId,
      messages,
      system,
      max_tokens: 4096,
      stream: true,
      temperature: 0.2
    };
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(payload),
      signal: options?.signal
    });
    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`Anthropic API error: ${response.status} - ${errBody}`);
    }
    if (!response.body) throw new Error('Empty response body');
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const cleaned = line.trim();
        if (!cleaned) continue;
        if (cleaned.startsWith('data: ')) {
          try {
            const data = JSON.parse(cleaned.slice(6));
            if (data.type === 'content_block_delta' && data.delta?.text) {
              yield { type: 'delta', content: data.delta.text };
            }
          } catch {}
        }
      }
    }
    yield { type: 'done' };
  }
}

import { AuthenticationRouter } from './auth-router';
import { ServerModelRouter } from './server-router';
import { ServerUsageStore } from './usage-store';
import { ServerBudgetGuard } from './budget-guard';
import { BurstLimiter, estimateRequestCost, getPlanPolicy, tokenCost, type RequestPurpose } from './usage-limits';
import { GoogleGeminiAdapter } from './google-adapter';
import type { AgentLogger } from '../orchestrator';

export let Sentry: any = null;
export let sentryLoadPromise: Promise<void> | null = null;
export function ensureSentryLoaded() {
  if (!sentryLoadPromise) {
    sentryLoadPromise = import('@sentry/electron/main')
      .then(m => { Sentry = m; })
      .catch(() => { Sentry = null; });
  }
  return sentryLoadPromise;
}

export function _resetSentryLoaderForTest() {
  Sentry = null;
  sentryLoadPromise = null;
}

export class BackendAIGateway {
  private adapters = new Map<string, ProviderAdapter>();
  readonly authService = new AuthenticationRouter();
  private router = new ServerModelRouter();
  readonly usageStore = new ServerUsageStore();
  readonly budgetGuard = new ServerBudgetGuard();
  readonly burstLimiter = new BurstLimiter();
  private readonly logger: AgentLogger;

  getContextLimit(tier: CapabilityTier): number {
    const config = this.router.route(tier);
    const modelProfile = (this.router as any)['registry']?.get(config.modelId);
    return modelProfile?.contextWindow ?? 128000;
  }

  constructor(logger?: AgentLogger) {
    setInterval(() => this.burstLimiter.prune(), 5 * 60_000).unref();
    this.logger = logger ?? {
      info: (msg, meta) => console.log(`[Gateway] ${msg}`, meta ?? ''),
      warn: (msg, meta) => console.warn(`[Gateway] ${msg}`, meta ?? ''),
      error: (msg, meta) => console.error(`[Gateway] ${msg}`, meta ?? ''),
    };
    const googleKey = process.env.GOOGLE_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;
    const anthropicKey = process.env.ANTHROPIC_API_KEY;

    this.adapters.set('google', new GoogleGeminiAdapter(googleKey));

    if (openaiKey) {
      this.adapters.set('openai', new OpenAIAdapter(openaiKey));
    } else if (googleKey) {
      this.adapters.set('openai', new GoogleGeminiAdapter(googleKey));
    } else {
      this.adapters.set('openai', new MockOpenAIAdapter());
    }

    if (anthropicKey) {
      this.adapters.set('anthropic', new AnthropicAdapter(anthropicKey));
    } else if (googleKey) {
      this.adapters.set('anthropic', new GoogleGeminiAdapter(googleKey));
    } else {
      this.adapters.set('anthropic', new MockOpenAIAdapter());
    }

  }

  async handleRequest(
    _method: 'POST',
    path: string,
    headers: Record<string, string>,
    body: any,
    options?: { signal?: AbortSignal }
  ): Promise<{ status: number; headers: Record<string, string>; body: any }> {
    const requestId = headers['x-request-id'] || randomUUID();
    const serverStart = Date.now();
    const clientStartHeader = headers['x-synkro-client-start'] || headers['X-Synkro-Client-Start'];
    const transitTime = clientStartHeader ? (serverStart - parseInt(clientStartHeader, 10)) : -1;
    console.log(`[REQ ${requestId}] BackendAIGateway.handleRequest entered`);
    const responseHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-request-id': requestId
    };

    // Kill switch check
    const { db } = await import('./db');
    try {
      const ksRes = await db.query("SELECT value FROM system_config WHERE key = 'global_kill_switch'");
      if (ksRes.rows.length > 0 && ksRes.rows[0].value.is_active) {
        return { status: 503, headers: responseHeaders, body: { code: 'SERVICE_UNAVAILABLE', message: 'System is currently disabled by global kill switch.' } };
      }
    } catch (e) {
      console.error('[KillSwitch] Error checking kill switch:', e);
    }

    // --- Unauthenticated Auth Routes ---
    if (path === '/v1/auth/signup') {
      try {
        const session = await this.authService.signup(body.email, body.password);
        return { status: 200, headers: responseHeaders, body: session };
      } catch (err: any) {
        return { status: 400, headers: responseHeaders, body: { code: 'AUTH_ERROR', message: err.message } };
      }
    }

    if (path === '/v1/auth/signin') {
      try {
        const session = await this.authService.login(body.email, body.password);
        return { status: 200, headers: responseHeaders, body: session };
      } catch (err: any) {
        return { status: 401, headers: responseHeaders, body: { code: 'AUTH_ERROR', message: err.message } };
      }
    }

    if (path === '/v1/auth/refresh') {
      try {
        const session = await this.authService.refresh(body.refreshToken);
        return { status: 200, headers: responseHeaders, body: session };
      } catch (err: any) {
        return { status: 401, headers: responseHeaders, body: { code: 'AUTH_ERROR', message: err.message } };
      }
    }

    // 1. Auth Boundary
    const authHeader = headers['authorization'] || headers['Authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return {
        status: 401,
        headers: responseHeaders,
        body: { code: 'UNAUTHORIZED', message: 'Missing or malformed Authorization header.' }
      };
    }
    const token = authHeader.substring(7);
    const authStart = Date.now();
    let session: any;
    try {
      session = await this.authService.validateSession(token, requestId);
    } catch (err: any) {
      console.error('[BackendAIGateway] validateSession error:', err);
      return {
        status: 401,
        headers: responseHeaders,
        body: { code: 'UNAUTHORIZED', message: err.message || 'Invalid authentication session token.' }
      };
    }
    const authDuration = Date.now() - authStart;

    // --- Authenticated Account Routes ---
    if (path === '/v1/auth/logout') {
      try {
        await this.authService.logout(token, body?.refreshToken);
        return { status: 200, headers: responseHeaders, body: { success: true } };
      } catch (err: any) {
        return { status: 500, headers: responseHeaders, body: { code: 'AUTH_ERROR', message: err.message } };
      }
    }

    if (path === '/v1/account/status') {
      const summary = await this.budgetGuard.getUsageSummary(session.userId, session.plan || 'free');
      return {
        status: 200,
        headers: responseHeaders,
        body: {
          email: session.email,
          tier: summary.plan,
          // `usage`/`limit` are this week's pool, kept for older clients.
          usage: summary.weeklyUsedUsd,
          limit: summary.weeklyPoolUsd,
          ...summary,
        }
      };
    }

    // 2. Path routing
    if (path === '/v1/ai/generate') {
      let requestData = body as AIRequest;
      const valErr = this.validateAIRequest(requestData);
      if (valErr) {
        return { status: 400, headers: responseHeaders, body: valErr };
      }

      let purpose: RequestPurpose = requestData.purpose === 'completion' ? 'completion' : 'chat';
      const policyResult = await this.applyUsagePolicy(session, requestData, responseHeaders);
      if ('response' in policyResult) return policyResult.response;
      requestData = policyResult.request;
      purpose = policyResult.purpose;

      let config: any;
      try {
        const routingStart = Date.now();
        config = this.router.route(requestData.tier, session?.plan || 'free', requestData.manualModel);
        const routingDuration = Date.now() - routingStart;

        let adapter = this.adapters.get(config.providerId) || this.adapters.get('openai')!;
        this.logRequest(requestId, 'generate', requestData);
        let result: AIResponse;
        
        const latencyOut: any = { listModelsDuration: 0, geminiCallDuration: 0 };
        const adapterStart = Date.now();
        try {
          result = await adapter.generate(requestData, { ...options, resolvedModelId: config.modelId, latencyOut });
        } catch (e: any) {
          if (this.isRetryable(e) && config.fallback) {
            console.log(`[BackendAIGateway] [${requestId}] Primary provider failed, failing over to fallback: ${config.fallback.providerId}`);
            adapter = this.adapters.get(config.fallback.providerId) || this.adapters.get('openai')!;
            result = await adapter.generate(requestData, { ...options, resolvedModelId: config.fallback.modelId, latencyOut });
            responseHeaders['x-provider-fallback'] = config.fallback.providerId;
          } else {
            throw e;
          }
        }
        const adapterDuration = Date.now() - adapterStart;
        const serverDuration = Date.now() - serverStart;

        // Build the Latency Header
        responseHeaders['x-synkro-latency'] = `Transit: ${transitTime}ms | Auth: ${authDuration}ms | Route: ${routingDuration}ms | Resolve: ${latencyOut.listModelsDuration}ms | GeminiAPI: ${latencyOut.geminiCallDuration}ms | AdapterTotal: ${adapterDuration}ms | BackendTotal: ${serverDuration}ms`;

        const inputTokens = result.usage?.inputTokens || Math.ceil(JSON.stringify(requestData.messages).length / 4);
        const outputTokens = result.usage?.outputTokens || Math.ceil((result.content?.length ?? 0) / 4);
        await this.usageStore.recordUsage({
          userId: session.userId,
          requestId,
          modelTier: requestData.tier,
          resolvedModel: config.modelId,
          inputTokens,
          outputTokens,
          totalTokens: result.usage?.totalTokens || inputTokens + outputTokens,
          estimatedCost: result.cost?.cost || tokenCost(config, inputTokens, outputTokens),
          status: 'success',
          purpose,
        });

        return { status: 200, headers: responseHeaders, body: result };
      } catch (e: any) {
        await this.usageStore.recordUsage({
          userId: session.userId,
          requestId,
          modelTier: requestData.tier,
          resolvedModel: config?.modelId || 'unknown',
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          estimatedCost: 0,
          status: options?.signal?.aborted ? 'cancelled' : 'failed',
          purpose,
        });
        return { status: 502, headers: responseHeaders, body: this.mapError(e) };
      }
    }

    if (path === '/v1/ai/stream') {
      let requestData = body as AIRequest;
      const valErr = this.validateAIRequest(requestData);
      if (valErr) {
        return { status: 400, headers: responseHeaders, body: valErr };
      }

      let purpose: RequestPurpose = requestData.purpose === 'completion' ? 'completion' : 'chat';
      const policyResult = await this.applyUsagePolicy(session, requestData, responseHeaders);
      if ('response' in policyResult) return policyResult.response;
      requestData = policyResult.request;
      purpose = policyResult.purpose;

      let config: any;
      try {
        const routingStart = Date.now();
        config = this.router.route(requestData.tier, session?.plan || 'free', requestData.manualModel);
        const routingDuration = Date.now() - routingStart;

        let adapter = this.adapters.get(config.providerId) || this.adapters.get('openai')!;
        this.logRequest(requestId, 'stream', requestData);
        let stream: any;

        const latencyOut: any = { listModelsDuration: 0, geminiCallDuration: 0 };
        const adapterStart = Date.now();
        try {
          stream = adapter.stream(requestData, { ...options, resolvedModelId: config.modelId, latencyOut });
        } catch (e: any) {
          if (this.isRetryable(e) && config.fallback) {
            console.log(`[BackendAIGateway] [${requestId}] Primary streaming failed, failing over to: ${config.fallback.providerId}`);
            adapter = this.adapters.get(config.fallback.providerId) || this.adapters.get('openai')!;
            stream = adapter.stream(requestData, { ...options, resolvedModelId: config.fallback.modelId, latencyOut });
            responseHeaders['x-provider-fallback'] = config.fallback.providerId;
            // Materialize fallback stream start
            const testFallback = await stream[Symbol.asyncIterator]().next();
            const originalIterator = stream[Symbol.asyncIterator];
            stream[Symbol.asyncIterator] = async function* () {
              if (!testFallback.done) yield testFallback.value;
              yield* originalIterator.call(stream);
            };
          } else {
            throw e;
          }
        }
        const adapterDuration = Date.now() - adapterStart;
        const serverDuration = Date.now() - serverStart;

        // Build the Latency Header
        responseHeaders['x-synkro-latency'] = `Transit: ${transitTime}ms | Auth: ${authDuration}ms | Route: ${routingDuration}ms | Resolve: ${latencyOut.listModelsDuration}ms | GeminiAPI: ${latencyOut.geminiCallDuration}ms | AdapterTotal: ${adapterDuration}ms | BackendTotal: ${serverDuration}ms`;

        const originalStream = stream;
        const self = this;
        const wrappedStream = {
          async *[Symbol.asyncIterator]() {
            let finalUsage: any = null;
            let finalModelId: string | undefined = undefined;
            let finalStatus: 'success' | 'cancelled' | 'failed' = 'success';
            let accumulatedOutputChars = 0;
            try {
              for await (const chunk of originalStream) {
                if (chunk.type === 'done' && chunk.usage) {
                  finalUsage = chunk.usage;
                }
                if (chunk.type === 'delta' || chunk.type === 'content') {
                  const text = chunk.content ?? chunk.delta ?? '';
                  accumulatedOutputChars += typeof text === 'string' ? text.length : 0;
                }
                if (chunk.modelId) finalModelId = chunk.modelId;
                else if (chunk.model) finalModelId = chunk.model;
                yield chunk;
              }
            } catch (err: any) {
              if (err.name === 'AbortError' || (options?.signal && options.signal.aborted)) {
                finalStatus = 'cancelled';
              } else {
                finalStatus = 'failed';
              }
              throw err;
            } finally {
              const msgStr = JSON.stringify(requestData.messages || (requestData as any).prompt || '');
              const fallbackInputTokens = Math.ceil(msgStr.length / 4);
              const fallbackOutputTokens = accumulatedOutputChars > 0 ? Math.ceil(accumulatedOutputChars / 4) : 1;
              const iTokens = finalUsage?.inputTokens || finalUsage?.prompt_tokens || fallbackInputTokens;
              const oTokens = finalUsage?.outputTokens || finalUsage?.completion_tokens || fallbackOutputTokens;
              
              await self.usageStore.recordUsage({
                userId: session.userId,
                requestId,
                modelTier: requestData.tier,
                resolvedModel: finalModelId || config.modelId,
                inputTokens: iTokens,
                outputTokens: oTokens,
                totalTokens: finalUsage?.totalTokens || finalUsage?.total_tokens || (iTokens + oTokens),
                estimatedCost: tokenCost(config, iTokens, oTokens),
                status: options?.signal?.aborted ? 'cancelled' : finalStatus,
                purpose,
              }).catch(async (usageErr: any) => {
                self.logger.error('Failed to record streaming usage — financial data loss risk', { requestId, error: usageErr?.message });
                await ensureSentryLoaded();
                if (Sentry?.captureException) Sentry.captureException(usageErr, { tags: { requestId, path: '/v1/ai/stream' } });
              });
            }
          }
        };

        return { status: 200, headers: responseHeaders, body: wrappedStream };
      } catch (e: any) {
        console.error(`[BackendAIGateway] [${requestId}] Request failed with error:`, e);
        this.usageStore.recordUsage({
          userId: session.userId,
          requestId,
          modelTier: requestData.tier,
          resolvedModel: config?.modelId || 'unknown',
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          estimatedCost: 0,
          status: options?.signal?.aborted ? 'cancelled' : 'failed',
          purpose,
        }).catch(async (usageErr: any) => {
          this.logger.error('Failed to record stream error usage — financial data loss risk', { requestId, error: usageErr?.message });
          await ensureSentryLoaded();
          if (Sentry?.captureException) Sentry.captureException(usageErr, { tags: { requestId, path: '/v1/ai/stream' } });
        });
        return { status: 502, headers: responseHeaders, body: this.mapError(e) };
      }
    }

    if (path === '/v1/ai/estimate-cost') {
      const requestData = body as AIRequest;
      try {
        this.router.route(requestData.tier);
        const estimate: CostEstimate = {
          cost: requestData.tier === 'premium' ? 0.01 : (requestData.tier === 'reasoning' ? 0.005 : 0.001),
          currency: 'USD'
        };
        return { status: 200, headers: responseHeaders, body: estimate };
      } catch (e: any) {
        return { status: 400, headers: responseHeaders, body: { code: 'VALIDATION_ERROR', message: e.message } };
      }
    }

    return {
      status: 404,
      headers: responseHeaders,
      body: { code: 'NOT_FOUND', message: `Route not found: ${path}` }
    };
  }

  /**
   * Burst limit + plan usage pool (see usage-limits.ts). Returns the response to send when the
   * request is refused, otherwise the request to run — moved to the fast tier when a paid plan's
   * weekly pool is spent.
   */
  private async applyUsagePolicy(
    session: { userId: string; plan?: string },
    requestData: AIRequest,
    responseHeaders: Record<string, string>,
  ): Promise<
    | { response: { status: number; headers: Record<string, string>; body: any } }
    | { request: AIRequest; purpose: RequestPurpose }
  > {
    const purpose: RequestPurpose = requestData.purpose === 'completion' ? 'completion' : 'chat';
    const plan = session.plan || 'free';
    const policy = getPlanPolicy(plan);

    // Picking a specific model is a paid feature (like Cursor); free plans always use Auto routing.
    if (requestData.manualModel && !policy.allowModelSelection) {
      requestData = { ...requestData, manualModel: undefined };
      responseHeaders['x-synkro-model-locked'] = 'auto';
    }

    const perMinute = purpose === 'completion' ? policy.completionsPerMinute : policy.chatPerMinute;
    const retryAfterSec = this.burstLimiter.hit(`${session.userId}:${purpose}`, perMinute);
    if (retryAfterSec > 0) {
      return {
        response: {
          status: 429,
          headers: { ...responseHeaders, 'Retry-After': String(retryAfterSec) },
          body: { code: 'RATE_LIMIT_EXCEEDED', message: `Too many requests. Try again in ${retryAfterSec}s.`, retryAfterSec },
        },
      };
    }

    let prices;
    try {
      prices = this.router.route(requestData.tier, plan, requestData.manualModel);
    } catch {
      // e.g. premium on the free plan: routing rejects it later with a clear error.
      prices = this.router.route('fast', plan);
    }
    const estimatedCost = estimateRequestCost(prices, requestData.messages, purpose === 'completion' ? 100 : 1000);
    const decision = await this.budgetGuard.checkUsage(session.userId, plan, purpose, estimatedCost);
    if (decision.action === 'block') {
      return { response: { status: 429, headers: responseHeaders, body: decision.error } };
    }
    if (decision.action === 'fallback') {
      responseHeaders['x-synkro-usage-fallback'] = 'fast';
      return { request: { ...requestData, tier: 'fast', manualModel: undefined }, purpose };
    }
    return { request: requestData, purpose };
  }

  private validateAIRequest(req: AIRequest): AIError | null {
    if (!req) {
      return { code: 'VALIDATION_ERROR', message: 'Request body is empty.' };
    }
    if (!['fast', 'reasoning', 'premium'].includes(req.tier)) {
      return { code: 'VALIDATION_ERROR', message: `Invalid model tier: ${req.tier}` };
    }
    if ((!req.messages || req.messages.length === 0) && !(req as any).prompt) {
      return { code: 'VALIDATION_ERROR', message: 'Request messages is required.' };
    }
    return null;
  }

  private mapError(e: any): AIError {
    if (e.message === 'Provider request aborted') {
      return { code: 'REQUEST_CANCELLED', message: 'Request cancelled by the user.' };
    }
    return {
      code: 'PROVIDER_ERROR',
      message: `Provider request failed: ${e.message}`
    };
  }

  private logRequest(requestId: string, type: string, req: AIRequest): void {
    // Redact sensitive details in logs
    const msgStr = JSON.stringify(req.messages || (req as any).prompt || '');
    const redactedPrompt = msgStr ? (msgStr.length > 50 ? `${msgStr.substring(0, 50)}...` : msgStr) : '';
    console.log(`[BackendAIGateway] [${requestId}] type=${type} tier=${req.tier} prompt=${redactedPrompt}`);
  }

  private isRetryable(e: any): boolean {
    if (!e) return false;
    // Prefer typed ProviderError.retryable — this is the authoritative classification
    // set by error-classifier.ts from the provider's actual HTTP status / error code.
    if (e.name === 'ProviderError' && typeof e.retryable === 'boolean') {
      return e.retryable;
    }
    // Fallback heuristic for unclassified raw errors (e.g. pre-adapter network failures)
    const msg = String(e.message || '').toLowerCase();
    const isRetryableStatus = [429, 500, 502, 503, 504].includes(e.status);
    const isRetryableMsg = msg.includes('rate limit') || msg.includes('timeout') || msg.includes('overload') || msg.includes('temporary');
    return isRetryableStatus || isRetryableMsg;
  }
}
