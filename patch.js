const fs = require('fs');
const content = fs.readFileSync('src/ai/AIAgent.ts', 'utf8');

const newAnalyze = `  public async analyze(
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
        console.warn(\`AIAgent: Attempt \${attempt} failed (\${err.message}). Retrying in \${delayMs}ms...\`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    const finalError = lastError ?? new Error('AIAgent: All retry attempts exhausted.');
    vscode.window.showErrorMessage(\`Agentic Gatekeeper: AI Analysis Failed - \${finalError.message}\`);
    throw finalError;
  }`;

const split = content.split('  public async analyze(');
const before = split[0];
const after = split[1].substring(split[1].indexOf('throw finalError;') + 17 + '  }\n'.length);

fs.writeFileSync('src/ai/AIAgent.ts', before + newAnalyze + '\n}\n');
