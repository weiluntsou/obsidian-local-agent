/**
 * cloudApi.ts — Cloud LLM API Client (Gemini)
 *
 * A REST client for communicating with Google's Gemini API using the
 * OpenAI-compatible chat/completions endpoint.
 *
 * Uses Obsidian's `requestUrl` to bypass CORS restrictions.
 * Designed to mirror the LocalLLMClient interface for seamless swapping.
 */

import { requestUrl, RequestUrlParam } from "obsidian";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CloudChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CloudChatResponse {
  content: string;
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Gemini API base URL for AI Studio (OpenAI-compatible endpoint). */
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";

/** Request timeout in milliseconds (180 s — cloud synthesis can be slow). */
const CLOUD_REQUEST_TIMEOUT_MS = 180_000;

/** Available cloud model options. */
export const CLOUD_MODEL_OPTIONS: { value: string; label: string }[] = [
  { value: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite (預設)" },
  { value: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
  { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
];

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class CloudLLMClient {
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.apiKey = apiKey;
    this.model = model;
  }

  // ---- Configuration mutations --------------------------------------------

  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }

  setModel(model: string): void {
    this.model = model;
  }

  // ---- Core API -----------------------------------------------------------

  /**
   * Send a chat completion request to the Gemini API via the
   * OpenAI-compatible `/v1beta/openai/chat/completions` endpoint.
   */
  async chat(
    messages: CloudChatMessage[],
    temperature: number = 0.5
  ): Promise<CloudChatResponse> {
    if (!this.apiKey) {
      throw new Error("Cloud API Key 未設定。請至外掛設定頁面填入 Gemini API Key。");
    }

    const url = `${GEMINI_BASE_URL}/chat/completions`;

    const body = {
      model: this.model,
      messages,
      temperature,
      stream: false,
    };

    const request: RequestUrlParam = {
      url,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      throw: false,
    };

    const res = await requestUrl(request);

    if (res.status < 200 || res.status >= 300) {
      const errorText = res.text?.substring(0, 500) || "Unknown error";
      throw new Error(
        `Cloud API error (${res.status}): ${errorText}`
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
   * Convenience wrapper: single-turn prompt with a system message.
   */
  async prompt(
    systemPrompt: string,
    userPrompt: string,
    temperature: number = 0.5
  ): Promise<string> {
    const messages: CloudChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];
    const response = await this.chat(messages, temperature);
    return response.content;
  }

  // ---- Connectivity check -------------------------------------------------

  /**
   * Verify that the Gemini API is reachable with the configured key.
   * Uses the models list endpoint as a lightweight ping.
   */
  async ping(): Promise<boolean> {
    if (!this.apiKey) return false;

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${this.apiKey}`;
      const res = await requestUrl({
        url,
        method: "GET",
        throw: false,
      });
      return res.status >= 200 && res.status < 300;
    } catch {
      return false;
    }
  }
}
