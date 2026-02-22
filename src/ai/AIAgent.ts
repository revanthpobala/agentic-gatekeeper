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
1. If all files are 100% compliant, respond with only the word: COMPLIANT
2. If any file violates a rule, return a JSON array of objects for the fixes.
3. Every fix MUST contain the "filePath" and the "newContent" (the full rewritten code for that file).
4. Do not include any explanations or conversational text. Output only JSON or "COMPLIANT".

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
   */
  public async analyze(
    instructions: string,
    files: FileContext[],
    provider: IProvider,
    contextDepth: string = 'full'
  ): Promise<ProviderResult> {
    const systemPrompt = this.buildSystemPrompt(instructions, contextDepth);
    const userPrompt = this.buildUserPrompt(files);
    return await provider.execute(systemPrompt, userPrompt);
  }
}
