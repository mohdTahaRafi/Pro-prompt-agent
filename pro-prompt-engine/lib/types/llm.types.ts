export type ModelProvider = 'webgpu' | 'ollama' | 'groq';
export type ModelState = 'hot' | 'cold' | 'loading' | 'error';

// [Phase 1 §5.8] The six ids options/App.tsx actually offers. Previously this
// union declared three ids the UI never offered while the UI offered six the
// type rejected — the two lists shared no entries. WEBGPU_MODELS is the one
// exported const that stops that recurring: options/App.tsx maps it instead
// of carrying its own array literal.
export type WebGPUModel =
  | 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC'
  | 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC'
  | 'gemma-2-2b-it-q4f32_1-MLC'
  | 'Phi-3-mini-4k-instruct-q4f16_1-MLC'
  | 'TinyLlama-1.1B-Chat-v1.0-q4f32_1-MLC'
  | 'stablelm-2-zephyr-1_6b-q4f16_1-MLC';

export const WEBGPU_MODELS: readonly WebGPUModel[] = [
  'Qwen2.5-0.5B-Instruct-q4f16_1-MLC',
  'Qwen2.5-1.5B-Instruct-q4f32_1-MLC',
  'gemma-2-2b-it-q4f32_1-MLC',
  'Phi-3-mini-4k-instruct-q4f16_1-MLC',
  'TinyLlama-1.1B-Chat-v1.0-q4f32_1-MLC',
  'stablelm-2-zephyr-1_6b-q4f16_1-MLC',
] as const;

export interface LLMRequest {
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
  provider?: ModelProvider;
}

export interface LLMResponse {
  content: string;
  provider: ModelProvider;
  tokensUsed?: number;
  latencyMs: number;
  wasFallback: boolean;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: ModelProvider;
  sizeBytes?: number;
  sizeLabel?: string;
  isDownloaded: boolean;
  isActive: boolean;
  downloadProgress?: number;
}

export interface ProviderConfig {
  groq: { apiKey: string; model: string };
  ollama: { baseUrl: string; model: string };
  webgpu: { model: WebGPUModel | null; state: ModelState };
  activeProvider: ModelProvider;
}
