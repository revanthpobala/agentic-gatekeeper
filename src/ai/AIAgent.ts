import { IProvider, ProviderResult } from './IProvider';

export interface FileContext {
  filePath: string;
  content: string;
}

export class AIAgent {

  private buildSystemPrompt(instructions: string, contextDepth: string = 'full'): string {
    return `You are the 'Agentic Gatekeeper'. Your only task is to audit the provided files against the instructions below and fix any violations.

### AUDIT INSTRUCTIONS:
${instructions}

### EXECUTION RULES:
1. If all files are 100% compliant with every rule above, respond with exactly one word: OK
2. If any file violates a rule, return ONLY a JSON array of fix objects - no explanations, no prose.
3. Every fix object MUST contain "filePath" (the relative path as provided) and "newContent" (the complete rewritten file contents - never a placeholder, summary, or status word).
4. NEVER put a status word ("OK", "COMPLIANT", "PASS", or similar) as the value of "newContent". The "newContent" field must always be real file content.

### JSON FORMAT:
[
  {
    "filePath": "string",
    "newContent": "string"
  }
]
`;
  }

  private buildUserPrompt(files: FileContext[]): string {
    return `Here are the STAGED FILES with their current content:\n\n${files.map(f => `--- File: ${f.filePath} ---\n${f.content}\n`).join('\n')}`;
  }

  /**
   * Headless validation using the injected AI provider.
   * Retries up to 3 times with exponential backoff on transient failures.
   */
  public async analyze(
    instructions: string,
    files: FileContext[],
    provider: IProvider,
    contextDepth: string = 'full'
  ): Promise<ProviderResult> {
    const systemPrompt = this.buildSystemPrompt(instructions, contextDepth);
    const userPrompt = this.buildUserPrompt(files);

    const maxAttempts = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await provider.execute(systemPrompt, userPrompt);
        if (result.content !== null) { return result; }
        // null content is not retryable - provider already showed an error
        return result;
      } catch (err: any) {
        lastError = err;
        const isTransient = /429|503|502|ECONNRESET|ETIMEDOUT|network|timeout/i.test(err?.message || '');
        if (!isTransient || attempt === maxAttempts) { throw err; }
        const delayMs = Math.pow(2, attempt) * 1000; // 2s, 4s
        console.warn(`AIAgent: Attempt ${attempt} failed (${err.message}). Retrying in ${delayMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    throw lastError ?? new Error('AIAgent: All retry attempts exhausted.');
  }
}
