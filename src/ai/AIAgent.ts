import { IProvider } from './IProvider';

export interface FileContext {
  filePath: string;
  content: string;
}

export class AIAgent {

  private buildSystemPrompt(instructions: string): string {
    return `You are the 'Agentic Gatekeeper', a strict automated code reviewer and mutator acting as a pre-commit hook.
Your job is to read the provided PROJECT INSTRUCTIONS and apply them rigidly to the STAGED FILES provided by the user.

CRITICAL INSTRUCTION APPLICATION RULES:
1. Two-Tier Verification: Instructions are categorized into GLOBAL and DIRECTORY-SPECIFIC.
2. Global Instructions: You MUST apply these to EVERY staged file you evaluate.
3. Directory-Specific Instructions: You MUST check the file path of the STAGED FILE. You may ONLY apply a directory-specific rule if the staged file lives inside that rule's specific 'Domain Path'. (For example, if a rule has Domain Path 'src/ui', it DOES NOT apply to 'src/database/schema.ts').
4. Ignoring Irrelevant Rules: If a rule does not apply to the current file's domain, IGNORE IT COMPLETELY.

PROJECT INSTRUCTIONS:
${instructions}

TASK:
1. Analyze the STAGED FILES.
2. If the code is fully compliant, respond with EXACTLY the word "COMPLIANT".
3. If modifications are required, you MUST output a raw JSON array containing the full rewritten target files.
4. Do NOT output markdown code blocks formatting the JSON. Output only the raw valid JSON.

JSON SCHEMA:
[
  {
    "filePath": "src/path/to/file.ts",
    "newContent": "export function... // THE ENTIRE REWRITTEN FILE CONTENT"
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
  public async analyze(instructions: string, files: FileContext[], provider: IProvider): Promise<string | null> {
    const systemPrompt = this.buildSystemPrompt(instructions);
    const userPrompt = this.buildUserPrompt(files);
    return await provider.execute(systemPrompt, userPrompt);
  }
}
