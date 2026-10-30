import type {
  AIGateway,
  AIRequest,
  AIResponse,
  AIStreamEvent,
  CostEstimate,
  AIError,
  CapabilityTier
} from '@peep/shared';
import { classifyProviderError } from './error-classifier';

export interface ProductionAIGatewayOptions {
  baseUrl: string;
  sessionToken: string;
  refreshToken?: string;
  onTokensUpdated?: (sessionToken: string, refreshToken: string) => Promise<void>;
}

export class ProductionAIGateway implements AIGateway {
  constructor(private options: ProductionAIGatewayOptions) {}

  async generate(request: AIRequest, options?: { signal?: AbortSignal }): Promise<AIResponse> {
    const response = await this.makeRequest('/v1/ai/generate', request, options?.signal);
    return response.json();
  }

  async *stream(request: AIRequest, options?: { signal?: AbortSignal }): AsyncIterable<AIStreamEvent> {
    const response = await this.makeRequest('/v1/ai/stream', request, options?.signal);
    if (!response.body) {
      throw new Error('Response body is empty');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    try {
      while (true) {
        if (options?.signal?.aborted) {
          throw new Error('Request aborted');
        }

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (trimmed.startsWith('data: ')) {
            const jsonStr = trimmed.slice(6);
            if (jsonStr === '[DONE]') continue;
            try {
              const event: AIStreamEvent = JSON.parse(jsonStr);
              yield event;
            } catch (err) {
              console.error('Failed to parse stream event json:', err);
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
      if (options?.signal?.aborted) {
        await reader.cancel();
      }
    }
  }

  async estimateCost(request: AIRequest): Promise<CostEstimate> {
    const response = await this.makeRequest('/v1/ai/estimate-cost', request);
    return response.json();
  }

  getContextLimit(tier: CapabilityTier): number {
    // Conservative centralized configuration for token limits
    switch (tier) {
      case 'premium':
        return 128000;
      case 'reasoning':
        return 128000;
      case 'fast':
      default:
        return 128000;
    }
  }

  private async makeRequest(path: string, requestData: any, signal?: AbortSignal, isRetry = false): Promise<Response> {
    const url = `${this.options.baseUrl}${path}`;
    
    if (!this.options.sessionToken) {
      const err: AIError = { code: 'UNAUTHORIZED', message: 'No authentication session token provided.' };
      throw classifyProviderError(err);
    }

    console.log(`\n[HTTP_TRACE] POST URL: ${url}`);
    console.log(`[HTTP_TRACE] Headers: Content-Type=application/json, Authorization=Bearer ***, Session=***`);

    let response: Response;
    const fetchStart = Date.now();
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.options.sessionToken}`,
          'X-Synkro-Client-Start': fetchStart.toString()
        },
        body: JSON.stringify(requestData),
        signal
      });
      const fetchEnd = Date.now();
      const clientRoundtrip = fetchEnd - fetchStart;
      
      console.log(`[HTTP_TRACE] HTTP Status: ${response.status} ${response.statusText}`);
      const serverVersion = response.headers?.get('x-synkro-server-version') || '(unknown)';
      console.log(`[HTTP_TRACE] Server Version: ${serverVersion}`);
      
      const latencyHeader = response.headers?.get('x-synkro-latency');
      if (latencyHeader) {
        console.log(`[LATENCY_TRACE] ${latencyHeader} | Client Roundtrip: ${clientRoundtrip}ms`);
      } else {
        console.log(`[LATENCY_TRACE] Client Roundtrip: ${clientRoundtrip}ms`);
      }
      
      // We can only clone the response to read the body safely without breaking the stream reader
      if (typeof response.clone === 'function') {
        const clone = response.clone();
        try {
          const responseText = await clone.text();
          console.log(`[HTTP_TRACE] HTTP Body Preview: ${responseText.substring(0, 500)}`);
        } catch (e) {
          console.log(`[HTTP_TRACE] HTTP Body Preview Failed: ${e}`);
        }
      }
    } catch (e: any) {
      if (e.name === 'AbortError') {
        throw new Error('Request aborted');
      }
      console.log(`[HTTP_TRACE] Fetch Exception: ${e.message}`);
      const err: AIError = { code: 'NETWORK_FAILURE', message: `Network request failed: ${e.message}` };
      throw classifyProviderError(err);
    }

    if (!response.ok && response.status === 401 && !isRetry && this.options.refreshToken && this.options.onTokensUpdated) {
      // Attempt transparent refresh
      try {
        const refreshRes = await fetch(`${this.options.baseUrl}/v1/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: this.options.refreshToken })
        });
        
        if (refreshRes.ok) {
          const data = await refreshRes.json();
          if (data.sessionToken && data.refreshToken) {
            this.options.sessionToken = data.sessionToken;
            this.options.refreshToken = data.refreshToken;
            await this.options.onTokensUpdated(data.sessionToken, data.refreshToken);
            
            // Retry the original request
            return this.makeRequest(path, requestData, signal, true);
          }
        } else {
          // Refresh failed, probably reuse detection or expired
          await this.options.onTokensUpdated('', '');
        }
      } catch (refreshErr) {
        console.error('Failed to refresh token:', refreshErr);
      }
    }

    if (!response.ok) {
      let errDetail: any;
      try {
        errDetail = await response.json();
      } catch {
        errDetail = { message: response.statusText };
      }

      const status = response.status;
      let code = 'GATEWAY_ERROR';
      if (status === 401) code = 'UNAUTHORIZED';
      else if (status === 403) code = 'FORBIDDEN';
      else if (status === 429) code = 'RATE_LIMIT_EXCEEDED';
      else if (status === 400) code = 'VALIDATION_ERROR';
      else if (status === 502 || status === 503) code = 'GATEWAY_UNAVAILABLE';

      if (errDetail && errDetail.code === 'BUDGET_EXCEEDED') {
        code = 'BUDGET_EXCEEDED';
      }

      const err: AIError = {
        code,
        message: errDetail?.message || `HTTP error ${status}`,
        status
      };
      
      // Pass the Retry-After header if present
      let retryAfterMs;
      const retryHeader = response.headers.get('retry-after');
      if (retryHeader) {
        const seconds = parseInt(retryHeader, 10);
        if (!isNaN(seconds)) retryAfterMs = seconds * 1000;
      }
      
      const providerErr = classifyProviderError(err, status);
      if (retryAfterMs) {
         Object.defineProperty(providerErr, 'retryAfterMs', { value: retryAfterMs, writable: false });
      }
      throw providerErr;
    }

    return response;
  }
}
