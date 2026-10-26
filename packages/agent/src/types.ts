export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Images on a user message; each provider adapter maps them to its own format. */
  images?: import('@peep/shared').ChatImage[];
  tool_call_id?: string;
  name?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface AgentContextInput {
  projectPath?: string;
  treeSummary?: string;
  pubspec?: string;
  mainDart?: string;
  openFilePath?: string;
  openFileContent?: string;
  selectedCode?: {
    text: string;
    startLine: number;
    endLine: number;
    filePath: string;
  };
  diagnostics?: Array<{
    file: string;
    line: number;
    message: string;
    severity: string;
  }>;
  userMessage: string;
  previewError?: string;
}
