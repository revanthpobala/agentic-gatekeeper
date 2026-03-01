import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { GitContext } from './GitContext';
import { MarkdownParser } from './MarkdownParser';
import { WorkspacePatcher } from '../applier/WorkspacePatcher';
import { AIAgent, FileContext } from '../ai/AIAgent';
import { AIProviderFactory } from '../ai/AIProviderFactory';
import { ProviderResult, TokenUsage } from '../ai/IProvider';
import { groupIntoBatches, estimateTokens } from './BatchProcessor';
import * as crypto from 'crypto';
import { minimatch } from 'minimatch';
import { RemoteRulesSyncer } from './RemoteRulesSyncer';

// Pricing per 1M tokens (input / output) in USD
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
    'claude': { input: 3.00, output: 15.00 },
    'gpt-5': { input: 2.50, output: 10.00 },
    'gpt-4': { input: 5.00, output: 15.00 },
    'gpt-3': { input: 0.50, output: 1.50 },
    'gemini': { input: 0.10, output: 0.40 },
    'deepseek': { input: 0.14, output: 0.28 },
    'llama': { input: 0.00, output: 0.00 },
    'qwen': { input: 0.00, output: 0.00 },
};

function estimateCost(model: string, usage: TokenUsage): number {
    const key = Object.keys(MODEL_PRICING).find(k => model.toLowerCase().includes(k));
    const pricing = key ? MODEL_PRICING[key] : { input: 0, output: 0 };
    return (usage.promptTokens / 1_000_000) * pricing.input
        + (usage.completionTokens / 1_000_000) * pricing.output;
}

interface RunAudit {
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalCost: number;
    filesAnalyzed: number;
    apiCalls: number;
    modelUsed: string;
}

export class GatekeeperEngine {
    private workspaceRoot: string;
    private outputChannel: vscode.OutputChannel;
    private workspaceState: vscode.Memento;
    private remoteSync?: RemoteRulesSyncer;

    constructor(workspaceRoot: string, outputChannel: vscode.OutputChannel, workspaceState: vscode.Memento, remoteSync?: RemoteRulesSyncer) {
        this.workspaceRoot = workspaceRoot;
        this.outputChannel = outputChannel;
        this.workspaceState = workspaceState;
        this.remoteSync = remoteSync;
    }

    private accumulateAudit(audit: RunAudit, result: ProviderResult) {
        if (result.usage) {
            audit.totalPromptTokens += result.usage.promptTokens;
            audit.totalCompletionTokens += result.usage.completionTokens;
            audit.totalCost += estimateCost(result.model, result.usage);
        }
        audit.apiCalls++;
        if (result.model) {
            audit.modelUsed = result.model;
        }
    }

    private computeHash(content: string): string {
        return crypto.createHash('sha256').update(content).digest('hex');
    }

    /**
     * Batch-level retry wrapper for transient API failures (422/429).
     * AIAgent.analyze already handles 429/503 at the request level with 3 attempts,
     * but 422 (output token exceeded) often needs a cooldown + retry at the batch level.
     */
    private async analyzeWithRetry(
        orchestrator: AIAgent,
        instructions: string,
        batch: FileContext[],
        provider: any,
        contextDepth: string,
        batchMode: 'rewrite' | 'patch',
        maxRetries: number = 2
    ): Promise<ProviderResult> {
        let lastError: Error | null = null;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                return await orchestrator.analyze(instructions, batch, provider, contextDepth, batchMode);
            } catch (err: any) {
                lastError = err;
                const msg = err?.message || '';
                const isBatchRetryable = /422|429|rate.?limit|resource.?exhausted/i.test(msg);
                if (!isBatchRetryable || attempt === maxRetries) {
                    throw err;
                }
                const delayMs = Math.pow(2, attempt + 2) * 1000; // 4s, 8s
                this.outputChannel.appendLine(`  ⚠️ Batch retry ${attempt + 1}/${maxRetries}: ${msg.substring(0, 80)}... waiting ${delayMs / 1000}s`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }
        throw lastError ?? new Error('analyzeWithRetry: All attempts exhausted.');
    }

    private printAudit(audit: RunAudit) {
        const totalTokens = audit.totalPromptTokens + audit.totalCompletionTokens;
        this.outputChannel.appendLine('');
        this.outputChannel.appendLine('--- Gatekeeper Audit ---');
        this.outputChannel.appendLine(`Provider Model: ${audit.modelUsed}`);
        this.outputChannel.appendLine(`Files Analyzed: ${audit.filesAnalyzed}`);
        this.outputChannel.appendLine(`API Calls Made: ${audit.apiCalls}`);
        if (totalTokens > 0) {
            this.outputChannel.appendLine(`Total Tokens: ${totalTokens.toLocaleString()} (Prompt: ${audit.totalPromptTokens.toLocaleString()} | Completion: ${audit.totalCompletionTokens.toLocaleString()})`);
            this.outputChannel.appendLine(`Estimated Cost (approx.): $${audit.totalCost.toFixed(4)}`);
        } else {
            this.outputChannel.appendLine('Tokens: N/A (Provider does not report usage)');
        }
        this.outputChannel.appendLine('------------------------');
    }

    public async run() {
        this.outputChannel.show(true);
        this.outputChannel.appendLine('\n--- Gatekeeper Protocol Initiated ---');

        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Agentic Gatekeeper",
                cancellable: true
            }, async (progress, token) => {
                const gitContext = new GitContext(this.workspaceRoot);

                // Pre-flight check: Git presence
                if (!(await gitContext.checkIsRepo())) {
                    this.outputChannel.appendLine('Result: Aborted. Workspace is not a Git repository.');
                    vscode.window.showErrorMessage('Agentic Gatekeeper: This extension requires a Git repository to function.');
                    return;
                }

                const markdownParser = new MarkdownParser(this.workspaceRoot, this.outputChannel, this.remoteSync);
                const patcher = new WorkspacePatcher(this.workspaceRoot, this.outputChannel);
                const orchestrator = new AIAgent();
                const config = vscode.workspace.getConfiguration('agenticGatekeeper');
                const isDryRun = config.get<boolean>('dryRun') === true;
                const userExcludes = config.get<string[]>('excludePatterns') || [];

                // Parse .gatekeeperignore if present
                try {
                    const ignorePath = path.join(this.workspaceRoot, '.gatekeeperignore');
                    const ignoreContent = await fs.promises.readFile(ignorePath, 'utf8');
                    const ignoreLines = ignoreContent.split(/\r?\n/)
                        .map(line => line.trim())
                        .filter(line => line.length > 0 && !line.startsWith('#'));
                    if (ignoreLines.length > 0) {
                        userExcludes.push(...ignoreLines);
                        this.outputChannel.appendLine(`Parsed ${ignoreLines.length} exclusion pattern(s) from .gatekeeperignore`);
                    }
                } catch {
                    // .gatekeeperignore not present — that's fine
                }

                // 1. Audit Rules
                progress.report({ message: "Discovering rules...", increment: 5 });
                const rules = await markdownParser.getRuleContext();

                if (rules.length === 0) {
                    this.outputChannel.appendLine('Result: No rule files found. Create .gatekeeper/*.md or run "Setup Instructions" first.');
                    const action = await vscode.window.showWarningMessage(
                        'Agentic Gatekeeper: No rule files found. Create rules first?',
                        'Create Rules', 'Cancel'
                    );
                    if (action === 'Create Rules') {
                        vscode.commands.executeCommand('agentic-gatekeeper.setupInstructions');
                    }
                    return;
                }

                const instructions = await markdownParser.getConsolidatedInstructions(rules);
                const ruleGlobs = rules
                    .map(r => r.globs)
                    .filter((g): g is string => !!g);

                // 2. AI Orchestration (Moved up for caching)
                const { provider, modeName } = AIProviderFactory.createProvider(this.outputChannel);
                const instructionsHash = this.computeHash(instructions + '|' + modeName);

                // 3. Audit Staged & Modified Files
                progress.report({ message: "Analyzing local changes...", increment: 5 });
                const stagedFiles = await gitContext.getStagedFiles();
                const modifiedFiles = await gitContext.getModifiedFiles();

                // Deduplicate files: we want to audit anything the user is actively working on
                const activeFiles = Array.from(new Set([...stagedFiles, ...modifiedFiles]));

                const fileContexts: FileContext[] = [];

                // Paths that are rule/config sources - don't analyze these as code
                const skipPrefixes = ['.gatekeeper/', '.cursor/', '.github/', '.agents/'];
                const skipExact = ['agents.md', 'AGENTS.md', 'CONTRIBUTING.md', 'ARCHITECTURE.md'];

                // Directories to completely ignore anywhere in the path (e.g., dependencies, build outputs)
                const skipDirectories = [
                    // Node / Web
                    'node_modules', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', 'coverage',
                    // Python
                    'venv', '.venv', 'env', '.env', '__pycache__', '.pytest_cache', '.tox', 'eggs',
                    // PHP / Go / Ruby
                    'vendor',
                    // Java / C# / Rust
                    'target', 'bin', 'obj', '.gradle',
                    // iOS / macOS
                    'Pods', 'DerivedData',
                    // IDEs
                    '.idea', '.vs'
                ];

                // File extensions that are never useful to send to an LLM
                const skipExtensions = [
                    '.lock', '.snap', '.map', '.min.js', '.min.css',
                    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg',
                    '.woff', '.woff2', '.ttf', '.eot',
                    '.zip', '.tar', '.gz', '.tgz',
                    '.pdf', '.exe', '.bin', '.dylib', '.so', '.dll',
                ];

                // File names that are typically generated/lock files
                const skipFilenames = [
                    'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
                    'Cargo.lock', 'poetry.lock', 'Pipfile.lock', 'composer.lock',
                    'go.sum', 'package.min.js', 'package.min.css'
                ];

                const contextDepth = config.get<string>('contextDepth') || 'full';
                const largeFileThreshold = config.get<number>('largeFileThreshold') || 200;

                for (const relativePath of activeFiles) {
                    const basename = path.basename(relativePath);
                    const ext = path.extname(relativePath).toLowerCase();

                    const matchesUserExclude = userExcludes.some(pattern =>
                        minimatch(relativePath, pattern, { matchBase: true, dot: true })
                    );

                    let shouldSkip = skipPrefixes.some(p => relativePath.startsWith(p)) ||
                        skipDirectories.some(d => relativePath.split(/[/\\]/).includes(d)) ||
                        skipExact.includes(relativePath) ||
                        relativePath.endsWith('-gatekeeper.md') ||
                        relativePath.endsWith('-instructions.md') ||
                        skipFilenames.includes(basename) ||
                        skipExtensions.some(e => relativePath.endsWith(e)) ||
                        (ext === '' && basename.startsWith('.')) || // dotfiles with no extension
                        matchesUserExclude;

                    // If rules have globs defined, skip files that don't match any
                    if (!shouldSkip && ruleGlobs.length > 0) {
                        const matchesAnyGlob = ruleGlobs.some(glob =>
                            glob.split(',').some(g => minimatch(relativePath, g.trim(), { matchBase: true }))
                        );
                        if (!matchesAnyGlob) {
                            shouldSkip = true;
                        }
                    }

                    if (shouldSkip) {
                        this.outputChannel.appendLine(`  [Skipped] ${relativePath}`);
                        continue;
                    }

                    const fullPath = path.join(this.workspaceRoot, relativePath);
                    try {
                        const stats = await fs.promises.stat(fullPath);
                        if (stats.isFile()) {
                            const rawContent = await fs.promises.readFile(fullPath, 'utf8');
                            const lineCount = rawContent.split(/\r?\n/).length;

                            let content = rawContent;
                            // Auto-switch to diff if > 1000 lines
                            const effectiveContextDepth = (contextDepth === 'full' && lineCount > 1000) ? 'diff' : contextDepth;

                            if (effectiveContextDepth === 'diff') {
                                const diffContent = await gitContext.getStagedDiff(relativePath);
                                if (diffContent && diffContent.trim() !== '') {
                                    content = diffContent;
                                    if (contextDepth !== 'diff') {
                                        this.outputChannel.appendLine(`  [Diff-Only] ${relativePath} (${lineCount} lines) auto-switched to diff mode to save tokens.`);
                                    }
                                }
                            }

                            // Always hash the raw file content for caching (not the diff)
                            const contentHash = this.computeHash(rawContent);
                            const cacheKey = `gatekeeper:cache:${relativePath}`;
                            const cached: any = this.workspaceState.get(cacheKey);

                            if (cached && cached.contentHash === contentHash && cached.rulesHash === instructionsHash && cached.result === "OK") {
                                this.outputChannel.appendLine(`  [Cached] ${relativePath} is Compliant.`);
                                continue;
                            }

                            fileContexts.push({ filePath: relativePath, content, contentHash, lineCount });
                        }
                    } catch (err) {
                        // Skip files that cannot be read
                    }
                }

                if (fileContexts.length === 0) {
                    this.outputChannel.appendLine('Result: No local changes found.');
                    vscode.window.showInformationMessage('No active changes found to analyze. Please modify a file first.');
                    return;
                }

                const executionStrategy = config.get<string>('executionStrategy') || 'aggregated';
                const isConcurrent = executionStrategy === 'streaming' || (config.get<string>('concurrencyMode') === 'Concurrent' && executionStrategy !== 'continuous');
                const maxTokensPerBatch = config.get<number>('maxTokensPerBatch') || 30000;

                const instructionTokens = estimateTokens(instructions);

                // Smart batching: group files by directory to maximize AI context locality, then by size
                fileContexts.sort((a, b) => {
                    const dirCompare = path.dirname(a.filePath).localeCompare(path.dirname(b.filePath));
                    return dirCompare !== 0 ? dirCompare : (a.lineCount ?? 0) - (b.lineCount ?? 0);
                });

                let batches: FileContext[][] = [];
                try {
                    const batchResult = groupIntoBatches(fileContexts, {
                        maxTokensPerBatch,
                        instructionTokens,
                        safetyBuffer: 2000,
                        largeFileThreshold,
                        maxRewriteFilesPerBatch: 5 // Cap rewrite blocks to prevent 422 output token errors
                    });
                    batches = batchResult.batches;

                    if (batchResult.skipped.length > 0) {
                        this.outputChannel.appendLine(`  [Too Large] Skipped ${batchResult.skipped.length} file(s) exceeding token budget:`);
                        for (const s of batchResult.skipped) {
                            this.outputChannel.appendLine(`    - ${s}`);
                        }
                        vscode.window.showWarningMessage(
                            `Agentic Gatekeeper: ${batchResult.skipped.length} file(s) were too large to analyze and were skipped. See Output.`
                        );
                    }
                } catch (batchError: any) {
                    this.outputChannel.appendLine(`Fatal Batching Error: ${batchError.message}`);
                    vscode.window.showErrorMessage(`Agentic Gatekeeper: ${batchError.message}`);
                    return;
                }

                if (batches.length === 0) {
                    this.outputChannel.appendLine('Result: No analyzable files after filtering.');
                    vscode.window.showInformationMessage('Agentic Gatekeeper: No files could be analyzed (all were too large or filtered out).');
                    return;
                }

                // Warn before firing many API calls (e.g. initial commit)
                if (batches.length > 10) {
                    const proceed = await vscode.window.showWarningMessage(
                        `Agentic Gatekeeper: This will make ${batches.length} API calls (${fileContexts.length} files). Continue?`,
                        'Continue', 'Cancel'
                    );
                    if (proceed !== 'Continue') {
                        this.outputChannel.appendLine('⚠️ Analysis cancelled by user (large batch warning).');
                        return;
                    }
                }

                const totalFiles = fileContexts.length;
                const allChanges: any[] = [];
                const allPatches: any[] = [];
                let hasViolations = false;
                let hasErrors = false;

                const audit: RunAudit = {
                    totalPromptTokens: 0,
                    totalCompletionTokens: 0,
                    totalCost: 0,
                    filesAnalyzed: totalFiles,
                    apiCalls: 0,
                    modelUsed: modeName,
                };

                const processBatchResult = async ({ batch, batchMode, result, error }: { batch: FileContext[], batchMode: 'rewrite' | 'patch', result: ProviderResult, error?: string }) => {
                    this.accumulateAudit(audit, result);
                    const fileNames = batch.map(f => f.filePath).join(', ');

                    if (error || !result.content) {
                        hasErrors = true;
                        this.outputChannel.appendLine(`Error: Validation engine failed on batch [${fileNames}]. (${error || 'No response'})`);
                        return;
                    }

                    if (result.content.trim().toUpperCase() !== "OK") {
                        let parsedValid = false;

                        if (batchMode === 'patch') {
                            const patches = patcher.parseAIPatchResponse(result.content);
                            const validPatches = patcher.filterPatches(patches);
                            if (validPatches && validPatches.length > 0) {
                                hasViolations = true;
                                parsedValid = true;
                                allPatches.push(...validPatches);
                                const patchedFilePaths = new Set(validPatches.map(p => p.filePath));
                                for (const p of validPatches) {
                                    this.outputChannel.appendLine(`  -> Violations found in ${p.filePath}: "${p.reason || 'Auto-patch mapped'}"`);
                                }

                                // Cache files not mentioned in patches — they passed
                                for (const f of batch) {
                                    if (!patchedFilePaths.has(f.filePath)) {
                                        this.outputChannel.appendLine(`  -> ${f.filePath} is Compliant (no patches returned).`);
                                        this.workspaceState.update(`gatekeeper:cache:${f.filePath}`, {
                                            contentHash: f.contentHash,
                                            rulesHash: instructionsHash,
                                            result: "OK"
                                        });
                                    }
                                }

                                if ((executionStrategy === 'continuous' || executionStrategy === 'streaming') && !isDryRun && contextDepth !== 'diff') {
                                    if (token.isCancellationRequested) {
                                        this.outputChannel.appendLine(`  -> Cancelled — skipping batch patch application.`);
                                        return;
                                    }
                                    const success = await patcher.applyPatches(validPatches);
                                    if (success) {
                                        await gitContext.stageFiles(validPatches.map(p => p.filePath));
                                        this.outputChannel.appendLine(`  -> Batch patches applied and staged successfully.`);
                                    } else {
                                        this.outputChannel.appendLine(`  -> Batch patch application failed.`);
                                        hasErrors = true;
                                    }
                                }
                            }
                        } else {
                            const changes = patcher.parseAIResponse(result.content);
                            if (changes && changes.length > 0) {
                                parsedValid = true;

                                const realChanges = [];
                                const changedFilePaths = new Set<string>();

                                for (const change of changes) {
                                    changedFilePaths.add(change.filePath);
                                    const orig = batch.find(f => f.filePath === change.filePath);
                                    if (orig && change.newContent.trim() === orig.content.trim()) {
                                        // No-op: AI returned the file unchanged → it's already compliant
                                        this.outputChannel.appendLine(`  -> ${change.filePath} returned unchanged — treating as Compliant.`);
                                        this.workspaceState.update(`gatekeeper:cache:${change.filePath}`, {
                                            contentHash: orig.contentHash,
                                            rulesHash: instructionsHash,
                                            result: "OK"
                                        });
                                    } else {
                                        hasViolations = true;
                                        realChanges.push(change);
                                    }
                                }

                                // Cache files not mentioned in the AI response — they passed without changes
                                for (const f of batch) {
                                    if (!changedFilePaths.has(f.filePath)) {
                                        this.outputChannel.appendLine(`  -> ${f.filePath} is Compliant (no changes returned).`);
                                        this.workspaceState.update(`gatekeeper:cache:${f.filePath}`, {
                                            contentHash: f.contentHash,
                                            rulesHash: instructionsHash,
                                            result: "OK"
                                        });
                                    }
                                }

                                if (realChanges.length > 0) {
                                    allChanges.push(...realChanges);
                                    for (const change of realChanges) {
                                        const reason = change.reason || "(no reason provided)";
                                        this.outputChannel.appendLine(`  -> Violations found in ${change.filePath}: "${reason}" - Auto-fix mapped.`);
                                    }

                                    if ((executionStrategy === 'continuous' || executionStrategy === 'streaming') && !isDryRun && contextDepth !== 'diff') {
                                        if (token.isCancellationRequested) {
                                            this.outputChannel.appendLine(`  -> Cancelled — skipping batch rewrite application.`);
                                            return;
                                        }
                                        this.outputChannel.appendLine(`  -> Applying and staging fixes for this batch...`);
                                        const success = await patcher.applyChanges(realChanges);
                                        if (success) {
                                            await gitContext.stageFiles(realChanges.map((c: any) => c.filePath));
                                            this.outputChannel.appendLine(`  -> Batch fixes applied and staged successfully.`);
                                        } else {
                                            this.outputChannel.appendLine(`  -> Batch fix application failed.`);
                                            hasErrors = true;
                                        }
                                    }
                                }
                            }
                        }

                        if (!parsedValid) {
                            this.outputChannel.appendLine(
                                `  -> Ambiguous response for batch [${fileNames}] - not "OK" and no valid patches. Skipping cache to force re-analysis.`
                            );
                            this.outputChannel.appendLine(`Report:\n${result.content}`);
                        }
                    } else {
                        for (const f of batch) {
                            this.outputChannel.appendLine(`  -> ${f.filePath} is Compliant.`);
                            // Store in cache
                            this.workspaceState.update(`gatekeeper:cache:${f.filePath}`, {
                                contentHash: f.contentHash,
                                rulesHash: instructionsHash,
                                result: "OK"
                            });
                        }
                    }
                };

                this.outputChannel.appendLine(`Mode: ${modeName} | Strategy: ${executionStrategy} | Context: ${contextDepth}`);
                this.outputChannel.appendLine(`${totalFiles} file(s) -> ${batches.length} batch(es) | Budget: ${maxTokensPerBatch.toLocaleString()} tokens/batch`);

                if (isConcurrent) {
                    const maxConcurrent = config.get<number>('maxConcurrentRequests') || 5;
                    this.outputChannel.appendLine(`Execution: 🚀 Concurrent(Max ${maxConcurrent} parallel batches)`);

                    const results: { batch: FileContext[], batchMode: 'rewrite' | 'patch', result: ProviderResult, error?: string }[] = [];
                    let completedBatches = 0;

                    for (let i = 0; i < batches.length; i += maxConcurrent) {
                        if (token.isCancellationRequested) {
                            this.outputChannel.appendLine('⚠️ Analysis Aborted by User.');
                            vscode.window.showInformationMessage('Agentic Gatekeeper: Analysis aborted.');
                            return;
                        }

                        const concurrentBatches = batches.slice(i, i + maxConcurrent);

                        const promises = concurrentBatches.map(async (batch, idx) => {
                            const batchNum = i + idx + 1;
                            const fileNames = batch.map(f => f.filePath).join(', ');
                            const batchTokens = batch.reduce((sum, f) => sum + estimateTokens(f.content) + estimateTokens(f.filePath) + 50, 0) + instructionTokens;

                            // Determine if this batch requires PATCH mode
                            const requiresPatchMode = largeFileThreshold > 0 && batch.some(f => (f.lineCount ?? 0) > largeFileThreshold);
                            const batchMode: 'rewrite' | 'patch' = requiresPatchMode ? 'patch' : 'rewrite';

                            this.outputChannel.appendLine(`  -> Batch ${batchNum}/${batches.length} [${batchMode.toUpperCase()}] [${fileNames}]: ${batchTokens.toLocaleString()} tokens. Sending...`);

                            try {
                                const result = await this.analyzeWithRetry(orchestrator, instructions, batch, provider, contextDepth, batchMode);
                                const resultObj = { batch, batchMode, result };
                                if (executionStrategy === 'streaming') {
                                    await processBatchResult(resultObj);
                                }
                                completedBatches++;
                                progress.report({ message: `Analyzed ${completedBatches}/${batches.length} batches...`, increment: Math.floor(80 / batches.length) });
                                return resultObj;
                            } catch (err: any) {
                                const errResultObj = { batch, batchMode, result: { content: null, usage: null, model: modeName } as ProviderResult, error: err.message };
                                if (executionStrategy === 'streaming') {
                                    await processBatchResult(errResultObj);
                                }
                                completedBatches++;
                                progress.report({ message: `Analyzed ${completedBatches}/${batches.length} batches...`, increment: Math.floor(80 / batches.length) });
                                return errResultObj;
                            }
                        });

                        const batchResults = await Promise.all(promises);
                        if (executionStrategy !== 'streaming') {
                            results.push(...batchResults);
                        }
                    }

                    if (executionStrategy !== 'streaming') {
                        progress.report({ message: `Verifying final analysis results...` });
                        for (const r of results) {
                            await processBatchResult(r);
                        }
                    }

                } else {
                    this.outputChannel.appendLine(`Execution: 🛡️ Sequential${executionStrategy === 'continuous' ? ' (Continuous Apply)' : ''}`);

                    for (let i = 0; i < batches.length; i++) {
                        if (token.isCancellationRequested) {
                            this.outputChannel.appendLine('⚠️ Analysis Aborted by User.');
                            vscode.window.showInformationMessage('Agentic Gatekeeper: Analysis aborted.');
                            return;
                        }

                        const batch = batches[i];
                        const fileNames = batch.map(f => f.filePath).join(', ');
                        const batchTokens = batch.reduce((sum, f) => sum + estimateTokens(f.content) + estimateTokens(f.filePath) + 50, 0) + instructionTokens;

                        const requiresPatchMode = largeFileThreshold > 0 && batch.some(f => (f.lineCount ?? 0) > largeFileThreshold);
                        const batchMode = requiresPatchMode ? 'patch' : 'rewrite';

                        this.outputChannel.appendLine(`  -> Batch ${i + 1}/${batches.length} [${batchMode.toUpperCase()}] [${fileNames}]: ${batchTokens.toLocaleString()} tokens. Sending...`);
                        progress.report({ message: `Validating batch ${i + 1}/${batches.length} (${batch.length} files)...`, increment: Math.floor(80 / batches.length) });

                        try {
                            const result = await this.analyzeWithRetry(orchestrator, instructions, batch, provider, contextDepth, batchMode);
                            await processBatchResult({ batch, batchMode, result });
                        } catch (err: any) {
                            await processBatchResult({ batch, batchMode, result: { content: null, usage: null, model: modeName } as ProviderResult, error: err.message });
                        }
                    }
                }

                if (token.isCancellationRequested) {
                    this.outputChannel.appendLine('⚠️ Analysis Aborted by User before final apply.');
                    vscode.window.showInformationMessage('Agentic Gatekeeper: Analysis aborted. No changes applied.');
                    return;
                }



                // 4. Apply Results
                progress.report({ message: `Applying rule mutations...`, increment: 10 });

                if (!hasViolations && !hasErrors) {
                    this.outputChannel.appendLine('Result: OK (Entire changeset is Compliant)');
                    this.outputChannel.appendLine('Final Verification Complete: 0 files required patching.');
                    vscode.window.showInformationMessage('Agentic Gatekeeper: Code is fully compliant.');
                } else if (hasErrors && !hasViolations && allChanges.length === 0 && allPatches.length === 0) {
                    this.outputChannel.appendLine('Result: ⚠️ INCOMPLETE — One or more batches failed. Cannot confirm compliance.');
                    vscode.window.showWarningMessage('Agentic Gatekeeper: Analysis incomplete — AI provider errors occurred. See Output.');
                } else if (allChanges.length > 0 || allPatches.length > 0) {
                    const totalAffected = allChanges.length + allPatches.length;

                    if (contextDepth === 'diff') {
                        this.outputChannel.appendLine(`\nResult: ⚠️ AUDIT ONLY (Diff Mode). Found ${totalAffected} violation(s), but auto-fix is disabled for partial context.`);
                        this.outputChannel.appendLine(`Switch to Context Depth: "full" in settings to enable auto-patching.`);
                        vscode.window.showWarningMessage(`Agentic Gatekeeper: ${totalAffected} violations found. Switch to 'full' mode to auto-fix.`);
                    } else if (isDryRun) {
                        this.outputChannel.appendLine(`\nResult: 🧪 DRY RUN ENABLED. Skipping filesystem patches for ${totalAffected} file(s).`);
                        vscode.window.showInformationMessage(`Agentic Gatekeeper (Dry Run): ${totalAffected} file(s) would have been patched. See Output.`);
                    } else if (executionStrategy === 'continuous' || executionStrategy === 'streaming') {
                        this.outputChannel.appendLine(`\nResult: ✅ Execution Complete. ${totalAffected} file(s) patched and staged batch-by-batch.`);
                        vscode.window.showInformationMessage(`Agentic Gatekeeper: Patching complete (${totalAffected} files).`);
                    } else {
                        // Final cancellation guard before writing files
                        if (token.isCancellationRequested) {
                            this.outputChannel.appendLine('⚠️ Cancelled before applying changes. No files were modified.');
                            vscode.window.showInformationMessage('Agentic Gatekeeper: Cancelled. No files were modified.');
                            this.printAudit(audit);
                            return;
                        }

                        this.outputChannel.appendLine(`Result: Applying rules to ${totalAffected} file(s) (Rewrites: ${allChanges.length}, Patches: ${allPatches.length})...`);

                        let rewritesSuccess = true;
                        if (allChanges.length > 0) {
                            rewritesSuccess = await patcher.applyChanges(allChanges);
                            if (rewritesSuccess) await gitContext.stageFiles(allChanges.map(c => c.filePath));
                        }

                        let patchesSuccess = true;
                        if (allPatches.length > 0) {
                            patchesSuccess = await patcher.applyPatches(allPatches);
                            if (patchesSuccess) await gitContext.stageFiles(allPatches.map(p => p.filePath));
                        }

                        if (rewritesSuccess && patchesSuccess) {
                            this.outputChannel.appendLine('Workspace updated and re-staged.');
                            this.outputChannel.appendLine('Final Verification Complete: All identified changes were applied correctly.');
                            vscode.window.showInformationMessage(`Agentic Gatekeeper: Applied rules to ${totalAffected} file(s).`);
                        } else {
                            vscode.window.showWarningMessage(`Agentic Gatekeeper: Some auto-fixes failed to apply. Please review Output.`);
                        }
                    }
                } else {
                    this.outputChannel.appendLine('Result: Violations found but no auto-patches could be applied.');
                    vscode.window.showWarningMessage('Agentic Gatekeeper: Rule violations found. See Output for report.');
                }

                // 5. Print Audit Summary
                this.printAudit(audit);
            });
        } catch (error: any) {
            const msg = error?.message || String(error);
            this.outputChannel.appendLine(`FATAL ERROR: ${msg}`);
            vscode.window.showErrorMessage(`Agentic Gatekeeper Error: ${msg}`);
        }
    }
}
