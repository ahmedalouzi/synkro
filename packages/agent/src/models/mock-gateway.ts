import type {
  AIGateway,
  AIRequest,
  AIResponse,
  AIStreamEvent,
  CostEstimate,
  CapabilityTier,
  AIError
} from '@peep/shared';

export type MockScenario =
  | 'success'
  | 'streaming'
  | 'tool_call'
  | 'auth_error'
  | 'rate_limit'
  | 'budget_exceeded'
  | 'provider_error'
  | 'cancel';

export class MockAIGateway implements AIGateway {
  private scenario: MockScenario = 'success';

  private customToolCall?: any;

  setScenario(scenario: MockScenario): void {
    this.scenario = scenario;
  }

  setCustomToolCall(toolCall: any): void {
    this.customToolCall = toolCall;
    this.scenario = 'tool_call';
  }

  getContextLimit(_tier: CapabilityTier): number {
    return 100000;
  }

  async generate(request: AIRequest, options?: { signal?: AbortSignal }): Promise<AIResponse> {
    if (options?.signal?.aborted) {
      throw new Error('Request aborted');
    }
    this.checkSimulatedErrors();

    if (this.scenario === 'tool_call') {
      return {
        content: 'I need to run a command to assist with your project.',
        toolCalls: [
          this.customToolCall || {
            id: 'call-1',
            name: 'run_command',
            arguments: { command: 'echo "hello"' }
          }
        ],
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        cost: { cost: 0.001, currency: 'USD' }
      };
    }

    const lastUserMsg = request.messages ? request.messages.filter((m: any) => m.role === 'user').pop() : null;
    const promptText = (typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : ('')).trim();
    const lowerPrompt = promptText.toLowerCase();


    let content = '';

    // 1. Identity & Understanding Queries
    const isIdentityQuery = /\b(who are you|what are you|who created|who built|what is your name|do you understand|can you hear|what can you do)\b/i.test(lowerPrompt) ||
      /\b(sen kimsin|kimsin|adın ne|ismin ne|seni kim yaptı|beni anlıyor|anladın mı|beni duyuyor|ne yapabilirsin)\b/i.test(lowerPrompt) ||
      /(من أنت|من انت|ما اسمك|من طورك|من صنعك|هل تفهمني|هل تسمعني|ماذا يمكنك أن تفعل)/i.test(promptText);

    // 2. Greetings
    const isGreeting = /\b(hi|hello|hey|greetings|good morning|good afternoon|good evening|howdy|whats up|what's up)\b/i.test(lowerPrompt) ||
      /\b(merhaba|selam|günaydın|iyi günler|iyi akşamlar|nasılsın|neler yapıyorsun)\b/i.test(lowerPrompt) ||
      /(مرحبا|مرحباً|أهلا|أهلاً|سلام|صباح الخير|مساء الخير|كيفك|كيف حالك)/i.test(promptText);

    // 3. Explicit Coding / Project Tasks
    const isExplicitCodingTask = /\b(create|add|build|implement|fix|debug|refactor|review|edit|modify|change|update|write|check|screen|button|component|file|error|code)\b/i.test(lowerPrompt) ||
      /\b(oluştur|ekle|yap|düzelt|güncelle|incele|yaz|düzenle|değiştir|hata|buton|ekran|bileşen|dosya|kod)\b/i.test(lowerPrompt) ||
      /(أنشئ|أضف|اصنع|أصلح|عدل|راجع|اكتب|غير|حين|خطأ|زر|شاشة|ملف|كود)/i.test(promptText);

    if (isIdentityQuery) {
      if (/\b(sen|beni|kimsin|adın|anladın)\b/i.test(lowerPrompt)) {
        content = 'Ben Atomvs, sizin AI kodlama ve geliştirme asistanınızım. Evet, sizi gayet iyi anlıyorum! Sorularınızı yanıtlayabilir, sohbet edebilir veya projenizde kod düzenlemeleri yapmamı istediğinizde bana bildirebilirsiniz.';
      } else if (/(أنت|انت|اسمك|تفهمني|تسمعني)/i.test(promptText)) {
        content = 'أنا سفيان (Atomvs)، مساعدك الذكي للتطوير والبرمجة. نعم، أفهمك بشكل ممتاز! يمكنني الإجابة على أسئلتك، والتحدث معك، أو مساعدتك في كتابة وتعديل الكود وإصلاح الأخطاء.';
      } else {
        content = 'I am Atomvs, your AI development assistant. Yes, I understand you perfectly! I can answer general questions, discuss ideas, or help you write and debug code whenever you explicitly request it.';
      }
    } else if (isGreeting) {
      if (/\b(merhaba|selam|günaydın|iyi|nasılsın)\b/i.test(lowerPrompt)) {
        content = 'Merhaba! Size nasıl yardımcı olabilirim? İster sohbet edelim, ister projeniz üzerinde çalışalım.';
      } else if (/(مرحبا|مرحباً|أهلا|أهلاً|سلام|صباح|مساء)/i.test(promptText)) {
        content = 'مرحباً بك! كيف يمكنني مساعدتك اليوم؟ أنا هنا للإجابة على أسئلتك أو العمل على مشروعك.';
      } else {
        content = 'Hello! How can I help you today? Feel free to ask a question or let me know if you would like to work on your project.';
      }
    } else if (isExplicitCodingTask) {
      if (/\b(ekle|düzelt|yaz|düzenle|oluştur|hata|buton)\b/i.test(lowerPrompt)) {
        content = `Projenizde istediğiniz düzenleme için hemen yardımcı oluyorum: "${promptText}". Kod yapısını inceleyip gerekli değişiklikleri hazırlıyorum.`;
      } else if (/(أضف|أصلح|عدل|أنشئ|خطأ|زر)/i.test(promptText)) {
        content = `سأساعدك في تعديل مشروعك فوراً: "${promptText}". أقوم بتحليل الملفات وإعداد التعديلات المطلوبة.`;
      } else {
        content = `I'll help you with your project request: "${promptText}". Analyzing your project context and preparing the changes for you.`;
      }
    } else {
      // General Conversation & Information
      if (/\b(nedir|nasıl|neden|açıkla)\b/i.test(lowerPrompt)) {
        content = `Sorunuz için teşekkürler! "${promptText}" hakkında bilgi almak istiyorsunuz. Ben Atomvs olarak hem genel sorularınızı yanıtlayabilir hem de mobil uygulama projenizi geliştirebilirim.`;
      } else if (/(ما هو|كيف|لماذا|اشرح)/i.test(promptText)) {
        content = `شكراً لسؤالك! حول "${promptText}": بصفتي مساعدك الذكي، يمكنني الإجابة على استفساراتك العامة بالإضافة إلى تطوير وتعديل تطبيقاتك.`;
      } else {
        content = `I understand your message: "${promptText}". How would you like me to assist you with this?`;
      }
    }

    return {
      content,
      usage: { inputTokens: 10, outputTokens: 15, totalTokens: 25 },
      cost: { cost: 0.0005, currency: 'USD' }
    };
  }

  async *stream(request: AIRequest, options?: { signal?: AbortSignal }): AsyncIterable<AIStreamEvent> {
    if (options?.signal?.aborted) {
      throw new Error('Request aborted');
    }
    this.checkSimulatedErrors();

    const events: AIStreamEvent[] = [];

    if (this.scenario === 'tool_call') {
      events.push({
        type: 'tool_call',
        toolCall: this.customToolCall || {
          id: 'call-1',
          name: 'run_command',
          arguments: { command: 'echo "hello"' }
        }
      });
    } else if (this.scenario === 'streaming') {
      const chunks = ['Hello ', 'from ', 'mock ', 'gateway.'];
      for (const chunk of chunks) {
        events.push({ type: 'delta', content: chunk });
      }
    } else {
      const generated = await this.generate(request, options);
      const text = generated.content || 'Hello from mock gateway.';
      const words = text.split(/(\s+)/);
      for (let i = 0; i < words.length; i += 4) {
        const chunk = words.slice(i, i + 4).join('');
        if (chunk) {
          events.push({ type: 'delta', content: chunk });
        }
      }
    }

    events.push({
      type: 'done',
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      cost: { cost: 0.001, currency: 'USD' }
    });

    for (const event of events) {
      if (options?.signal?.aborted) {
        throw new Error('Request aborted');
      }
      yield event;
      // Small tick for realistic streaming
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }


  async estimateCost(request: AIRequest): Promise<CostEstimate> {
    const isPremium = request.tier === 'premium';
    return {
      cost: isPremium ? 0.01 : 0.001,
      currency: 'USD'
    };
  }

  private checkSimulatedErrors(): void {
    if (this.scenario === 'auth_error') {
      const err: AIError = { code: 'UNAUTHORIZED', message: 'Authentication failed' };
      throw err;
    }
    if (this.scenario === 'rate_limit') {
      const err: AIError = { code: 'RATE_LIMIT_EXCEEDED', message: 'Rate limit hit' };
      throw err;
    }
    if (this.scenario === 'budget_exceeded') {
      const err: AIError = { code: 'BUDGET_EXCEEDED', message: 'Task budget of $0.50 exceeded' };
      throw err;
    }
    if (this.scenario === 'provider_error') {
      const err: AIError = { code: 'PROVIDER_ERROR', message: 'Downstream LLM provider failed' };
      throw err;
    }
  }
}
