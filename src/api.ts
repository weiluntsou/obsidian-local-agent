/**
 * api.ts — Local LLM API Bridge
 *
 * A robust REST client for communicating with local LLM servers
 * (Ollama, LM Studio, or any OpenAI-compatible local endpoint).
 *
 * Uses Obsidian's `requestUrl` to bypass Chromium CORS restrictions
 * that would otherwise block localhost fetch requests from the
 * Electron renderer process.
 */

import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single message in the chat completion format. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** The shape of the response we expect from chat-completion endpoints. */
export interface ChatCompletionResponse {
  /** The raw text content returned by the model. */
  content: string;
  /** The model identifier echoed back (if available). */
  model?: string;
  /** Token usage statistics (if the server provides them). */
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

/** Configuration required to initialise the API client. */
export interface ApiClientConfig {
  /** Base URL of the local LLM server, e.g. "http://localhost:11434". */
  endpoint: string;
  /** The model identifier to use for inference. */
  model: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Known path mappings for popular local LLM servers.
 * The client will try the OpenAI-compatible path first, then fall back
 * to the Ollama-native path.
 */
const CHAT_PATHS = {
  /** OpenAI-compatible endpoint (works with LM Studio, vLLM, Ollama v0.1.24+). */
  openai: "/v1/chat/completions",
  /** Ollama-native chat endpoint. */
  ollama: "/api/chat",
} as const;

/** Request timeout in milliseconds (120 s — local models can be slow). */
const REQUEST_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalise a base URL by stripping trailing slashes.
 */
function normaliseEndpoint(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Build a `RequestUrlParam` for Obsidian's `requestUrl`.
 */
function buildRequest(
  url: string,
  body: Record<string, unknown>
): RequestUrlParam {
  return {
    url,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    throw: false, // we handle HTTP errors ourselves
  };
}

/**
 * Parse a potentially messy LLM response that may be wrapped in markdown
 * fences (` ```json ... ``` `) into a clean JSON object.
 *
 * Returns `null` if parsing fails entirely.
 */
export function parseJsonFromLLM<T = unknown>(raw: string): T | null {
  // 1. Try to extract a fenced code block first.
  const fenceRegex = /```(?:json)?\s*\n?([\s\S]*?)```/;
  const fenceMatch = raw.match(fenceRegex);
  const candidate = fenceMatch ? fenceMatch[1].trim() : raw.trim();

  // 2. Attempt direct parse.
  try {
    return JSON.parse(candidate) as T;
  } catch {
    // 3. Last resort — look for the first `{` and last `}` and try again.
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      try {
        return JSON.parse(candidate.substring(start, end + 1)) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// API Client
// ---------------------------------------------------------------------------

export class LocalLLMClient {
  private endpoint: string;
  private model: string;

  constructor(config: ApiClientConfig) {
    this.endpoint = normaliseEndpoint(config.endpoint);
    this.model = config.model;
  }

  // ---- Configuration mutations --------------------------------------------

  /** Update the endpoint at runtime (e.g. when settings change). */
  setEndpoint(endpoint: string): void {
    this.endpoint = normaliseEndpoint(endpoint);
  }

  /** Update the model at runtime. */
  setModel(model: string): void {
    this.model = model;
  }

  // ---- Core API -----------------------------------------------------------

  /**
   * Send a chat completion request to the local LLM.
   *
   * The client first attempts the OpenAI-compatible `/v1/chat/completions`
   * endpoint. If that returns a 404, it falls back to Ollama's native
   * `/api/chat` endpoint, adapting the request/response format accordingly.
   *
   * @param messages  The conversation history to send.
   * @param temperature  Sampling temperature (0-2). Defaults to 0.3 for
   *                     deterministic classification tasks.
   * @returns A normalised `ChatCompletionResponse`.
   * @throws If both endpoints fail or the server is unreachable.
   */
  async chat(
    messages: ChatMessage[],
    temperature: number = 0.3
  ): Promise<ChatCompletionResponse> {
    // --- Try OpenAI-compatible path first ----------------------------------
    try {
      const result = await this.chatOpenAI(messages, temperature);
      return result;
    } catch (err: unknown) {
      const is404 =
        err instanceof Error && err.message.includes("404");
      if (!is404) {
        throw err; // genuine failure — don't retry
      }
    }

    // --- Fallback to Ollama-native path ------------------------------------
    return this.chatOllama(messages, temperature);
  }

  /**
   * Convenience wrapper: single-turn prompt with a system message.
   */
  async prompt(
    systemPrompt: string,
    userPrompt: string,
    temperature: number = 0.3
  ): Promise<string> {
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];
    const response = await this.chat(messages, temperature);
    return response.content;
  }

  // ---- Connectivity check -------------------------------------------------

  /**
   * Verify that the configured endpoint is reachable.
   *
   * @returns `true` if the server responds, `false` otherwise.
   */
  async ping(): Promise<boolean> {
    try {
      // Ollama exposes a simple GET /api/tags; LM Studio responds to GET /v1/models.
      // We try both and succeed if either responds with 2xx.
      const urls = [
        `${this.endpoint}/api/tags`,
        `${this.endpoint}/v1/models`,
      ];

      for (const url of urls) {
        try {
          const res: RequestUrlResponse = await requestUrl({
            url,
            method: "GET",
            throw: false,
          });
          if (res.status >= 200 && res.status < 300) {
            return true;
          }
        } catch {
          // Try next URL
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  // ---- Private helpers ----------------------------------------------------

  /**
   * Send a request to the OpenAI-compatible chat endpoint.
   */
  private async chatOpenAI(
    messages: ChatMessage[],
    temperature: number
  ): Promise<ChatCompletionResponse> {
    const url = `${this.endpoint}${CHAT_PATHS.openai}`;
    const body = {
      model: this.model,
      messages,
      temperature,
      stream: false,
    };

    const res = await requestUrl(buildRequest(url, body));

    if (res.status === 404) {
      throw new Error(`404: OpenAI-compatible endpoint not found at ${url}`);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(
        `LLM API error (${res.status}): ${res.text?.substring(0, 300)}`
      );
    }

    const data = res.json;
    const choice = data?.choices?.[0];

    return {
      content: choice?.message?.content ?? "",
      model: data?.model,
      usage: data?.usage,
    };
  }

  /**
   * Send a request to the Ollama-native chat endpoint.
   */
  private async chatOllama(
    messages: ChatMessage[],
    temperature: number
  ): Promise<ChatCompletionResponse> {
    const url = `${this.endpoint}${CHAT_PATHS.ollama}`;
    const body = {
      model: this.model,
      messages,
      stream: false,
      options: {
        temperature,
      },
    };

    const res = await requestUrl(buildRequest(url, body));

    if (res.status < 200 || res.status >= 300) {
      throw new Error(
        `LLM API error (${res.status}): ${res.text?.substring(0, 300)}`
      );
    }

    const data = res.json;

    return {
      content: data?.message?.content ?? "",
      model: data?.model,
      usage: data?.prompt_eval_count
        ? {
            prompt_tokens: data.prompt_eval_count,
            completion_tokens: data.eval_count,
          }
        : undefined,
    };
  }
}
