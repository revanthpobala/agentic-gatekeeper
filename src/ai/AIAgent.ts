import * as vscode from 'vscode';
import { IProvider, ProviderResult } from './IProvider';

export interface FileContext {
  filePath: string;
  content: string;
  contentHash?: string;
  lineCount?: number;
}

export class AIAgent {

  private buildSystemPrompt(instructions: string, contextDepth: string = 'full'): string {
    return `You are the 'Agentic Gatekeeper', a strict compliance auditor. Your ONLY task is to enforce the rules below. Treat every instruction as a MANDATORY requirement, not a suggestion.

### ENFORCEMENT DIRECTIVE:
- You MUST check EVERY public function/method/type in EVERY file individually.
- If the instructions require tags, annotations, comments, or documentation on public symbols, then ANY public symbol missing those elements is a VIOLATION - not a suggestion to improve.
- Do NOT assume compliance. VERIFY each file by examining its actual content against the rules.
- Do NOT return "OK" unless you have confirmed that every single public symbol in every file fully satisfies every applicable rule.

### AUDIT INSTRUCTIONS:
${instructions}

### EXECUTION RULES:
1. If all files are 100% compliant with every rule above, respond with exactly one word: OK
2. If any file violates a rule, return ONLY a JSON array of fix objects - no explanations, no prose.
3. Every fix object MUST include a "reason" field explaining which rule was violated.
4. Every fix object MUST contain "filePath" (the relative path as provided) and "newContent" (the complete rewritten file contents - never a placeholder, summary, or status word).
5. NEVER put a status word ("OK", "COMPLIANT", "PASS", or similar) as the value of "newContent". The "newContent" field must always be real file content.

### JSON FORMAT:
[
  {
    "filePath": "string",
    "reason": "string",
    "newContent": "string"
  }
]
`;
  }

  private buildPatchSystemPrompt(instructions: string, contextDepth: string = 'full'): string {
    return `You are the 'Agentic Gatekeeper', a strict compliance auditor. Your ONLY task is to enforce the rules below. Treat every instruction as a MANDATORY requirement, not a suggestion.

### ENFORCEMENT DIRECTIVE:
- You MUST check EVERY public function/method/type in EVERY file individually.
- If the instructions require tags, annotations, comments, or documentation on public symbols, then ANY public symbol missing those elements is a VIOLATION - not a suggestion to improve.
- Do NOT assume compliance. VERIFY each file by examining its actual content against the rules.
- Do NOT return "OK" unless you have confirmed that every single public symbol in every file fully satisfies every applicable rule.

### AUDIT INSTRUCTIONS:
${instructions}

### EXECUTION RULES:
1. If all files are 100% compliant with every rule above, respond with exactly one word: OK
2. If any file violates a rule, return ONLY a JSON array of patch objects - no explanations, no prose.
3. Every patch object MUST include a "reason" field explaining which rule was violated.
4. Every patch object MUST contain "filePath" (the relative path as provided) and a "patches" array.
5. In the "patches" array, each object must have "search" and "replace" fields.
6. STRICT ANCHOR DIRECTIVE: Your "search" string MUST include at least 2 lines of unchanged surrounding context above and below the modified lines to ensure a unique match. Do NOT target generic single-line statements without surrounding context.
7. NEVER put a status word ("OK", "COMPLIANT", "PASS", or similar) as the value of "replace". The "replace" field must always be the real replacement code.

### JSON FORMAT:
[
  {
    "filePath": "string",
    "reason": "string",
    "patches": [
      {
        "search": "string",
        "replace": "string"
      }
    ]
  }
]
`;
  }

  private buildUserPrompt(files: FileContext[], batchMode: 'rewrite' | 'patch' = 'rewrite'): string {
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
    contextDepth: string = 'full',
    batchMode: 'rewrite' | 'patch' = 'rewrite'
  ): Promise<ProviderResult> {
    const systemPrompt = batchMode === 'patch' ? this.buildPatchSystemPrompt(instructions, contextDepth) : this.buildSystemPrompt(instructions, contextDepth);
    const userPrompt = this.buildUserPrompt(files, batchMode);

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
        const isTransient = /429|503|502|ECONNRESET|ETIMEDOUT|network|timeout/i.test(err?.message || '') &&
          !/401|403|400/i.test(err?.message || '');
        if (!isTransient || attempt === maxAttempts) { throw err; }
        const delayMs = Math.pow(2, attempt) * 1000; // 2s, 4s
        console.warn(`AIAgent: Attempt ${attempt} failed (${err.message}). Retrying in ${delayMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    const finalError = lastError ?? new Error('AIAgent: All retry attempts exhausted.');
    vscode.window.showErrorMessage(`Agentic Gatekeeper: AI Analysis Failed - ${finalError.message}`);
    throw finalError;
  }
}
