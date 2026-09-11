/**
 * Ambient types for Chrome's built-in Prompt API (`LanguageModel`) — not
 * shipped in @types/chrome as of this phase. Minimal surface: what
 * entrypoints/offscreen/main.ts and lib/model/engines/prompt-api.ts
 * actually call. §5.1.
 */

type LanguageModelAvailability = 'unavailable' | 'downloadable' | 'downloading' | 'available';

interface LanguageModelMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | LanguageModelMessageContentPart[];
}

interface LanguageModelMessageContentPart {
  type: 'text' | 'image';
  value?: string;
  text?: string;
}

interface LanguageModelDownloadProgressEvent extends Event {
  loaded: number;
}

interface LanguageModelCreateMonitor extends EventTarget {
  addEventListener(type: 'downloadprogress', listener: (e: LanguageModelDownloadProgressEvent) => void): void;
}

interface LanguageModelCreateOptions {
  initialPrompts?: LanguageModelMessage[];
  monitor?: (m: LanguageModelCreateMonitor) => void;
  signal?: AbortSignal;
}

interface LanguageModelPromptOptions {
  signal?: AbortSignal;
  responseConstraint?: unknown;
  omitResponseConstraintInput?: boolean;
}

interface LanguageModelSession {
  readonly inputUsage: number;
  prompt(input: string | LanguageModelMessageContentPart[], options?: LanguageModelPromptOptions): Promise<string>;
  clone(options?: { signal?: AbortSignal }): Promise<LanguageModelSession>;
  destroy(): void;
}

interface LanguageModelStatic {
  availability(): Promise<LanguageModelAvailability>;
  create(options?: LanguageModelCreateOptions): Promise<LanguageModelSession>;
}

declare const LanguageModel: LanguageModelStatic;
