import { IProvider, ProviderResult } from './IProvider';

export interface FileContext {
  filePath: string;
  content: string;
}

export class AIAgent {

  private buildSystemPrompt(instructions: string): string {
    return `You are the 'Agentic Gatekeeper', a world-class, uncompromising code auditor and auto-patcher.
Your mission: Rigidly enforce the PROJECT INSTRUCTIONS provided below onto the STAGED FILES.

### MANDATORY EXECUTION PROTOCOL:
1. **Instruction Hierarchy**:
   - **GLOBAL INSTRUCTIONS**: These apply to EVERY SINGLE FILE in the project. You MUST honor them for all files regardless of their path.
   - **DOMAIN-SPECIFIC INSTRUCTIONS**: These apply ONLY to files within the specified "Domain Path" (or its subdirectories).
2. **Strict Enforcement**: If the code is missing a tag, a comment, a type, or a pattern required by the instructions, it is **NON-COMPLIANT**.
3. **No False Positives**: Do NOT ignore a Global Rule because its source file lives in a different directory. "Global" means universal.
4. **Mutative Response**: For every non-compliant file, you MUST provide the FULL rewritten source code in the JSON format below.

### PROJECT INSTRUCTIONS:
${instructions}

### YOUR TASK:
1. Audit the STAGED FILES (provided in the User Message) against the Instructions.
2. If all files are 100% compliant, respond with EXACTLY the word "COMPLIANT".
3. If ANY file is non-compliant, output ONLY a raw JSON array of objects. Do NOT use markdown code blocks.

### JSON OUTPUT FORMAT:
[
  {
    "filePath": "path/to/file.ext",
    "newContent": "FULL_REWRITTEN_FILE_CONTENT"
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
  public async analyze(instructions: string, files: FileContext[], provider: IProvider): Promise<ProviderResult> {
    const systemPrompt = this.buildSystemPrompt(instructions);
    const userPrompt = this.buildUserPrompt(files);
    return await provider.execute(systemPrompt, userPrompt);
  }
}
