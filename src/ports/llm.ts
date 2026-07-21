export interface LlmProvider {
  readonly name: string;
  complete(prompt: string, opts: { signal: AbortSignal }): Promise<string>;
}
