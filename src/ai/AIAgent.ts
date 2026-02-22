import { IProvider, ProviderResult } from './IProvider';

export interface FileContext {
  filePath: string;
  content: string;
}

export class AIAgent {

  private buildSystemPrompt(instructions: string, contextDepth: string = 'full'): string {
    const isDiff = contextDepth === 'diff';
    return `You are the 'Agentic Gatekeeper', a world-class, uncompromising code auditor and auto-patcher.
Your mission: Rigidly enforce the PROJECT INSTRUCTIONS provided below onto the STAGED FILES.

${isDiff ? '### PATCH ANALYSIS MODE:\nYou are looking at GIT DIFFS (patches). Only audit the changed lines. If a rule requires full-file context that is missing from the patch, prioritize rules applicable to the changes.' : ''}

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
2. Think Step-by-Step: Is EVERY file 100% compliant? If even one tag or comment is missing, it is NOT compliant.
3. If all files are compliant, respond with EXACTLY the word "COMPLIANT".
4. If ANY file is non-compliant, output ONLY a raw JSON array of objects.
5. **Auto-Fix Protocol**:
   - If in FULL FILE mode: You MUST provide the FULL rewritten source code.
   - If in PATCH/DIFF mode: You MUST provide the FULL rewritten source code of the file (if you can infer it) OR return a fix for the violation in the same JSON structure. 
   Note: In DIFF mode, if you cannot safely rewrite the file, still list the file in the JSON with an empty "newContent" to flag the violation.

### JSON OUTPUT FORMAT:
[
  {
    "filePath": "path/to/file.ext",
    "newContent": "FULL_REWRITTEN_FILE_CONTENT_WITH_ALL_FIXES"
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
