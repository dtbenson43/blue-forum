export type OpenRouterToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type OpenRouterToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type OpenRouterMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: OpenRouterToolCall[];
    }
  | {
      role: "tool";
      tool_call_id: string;
      content: string;
    };

export type OpenRouterCompletionResult = {
  content: string | null;
  toolCalls: OpenRouterToolCall[];
  finishReason: string | null;
  promptTokens: number;
  completionTokens: number;
};

export class OpenRouterError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "OpenRouterError";
  }
}

export async function createChatCompletion(opts: {
  apiKey: string;
  model: string;
  messages: OpenRouterMessage[];
  tools?: OpenRouterToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  siteUrl?: string;
}): Promise<OpenRouterCompletionResult> {
  const payload: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.maxTokens ?? 1500,
  };

  if (opts.tools && opts.tools.length > 0) {
    payload.tools = opts.tools;
    payload.tool_choice = "auto";
  }

  let response: Response;
  try {
    response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": opts.siteUrl || "https://blue-forum.local",
        "X-Title": "BLUE//SIGNAL",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new OpenRouterError(`OpenRouter fetch failed: ${msg}`, 0, true);
  }

  const text = await response.text();
  if (!response.ok) {
    let detail = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } };
      if (parsed.error?.message) {
        detail = parsed.error.message;
      }
    } catch {
      // keep raw snippet
    }
    const retryable = response.status >= 500 || response.status === 408;
    throw new OpenRouterError(
      `OpenRouter HTTP ${response.status}: ${detail}`,
      response.status,
      retryable,
    );
  }

  let data: {
    choices?: Array<{
      finish_reason?: string | null;
      message?: {
        content?: string | null;
        tool_calls?: OpenRouterToolCall[];
      };
    }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
    };
  };

  try {
    data = JSON.parse(text);
  } catch {
    throw new OpenRouterError("OpenRouter returned invalid JSON", 502, true);
  }

  const choice = data.choices?.[0];
  if (!choice?.message) {
    throw new OpenRouterError("OpenRouter response missing choice message", 502, true);
  }

  return {
    content: choice.message.content ?? null,
    toolCalls: Array.isArray(choice.message.tool_calls)
      ? choice.message.tool_calls
      : [],
    finishReason: choice.finish_reason ?? null,
    promptTokens: data.usage?.prompt_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
  };
}
