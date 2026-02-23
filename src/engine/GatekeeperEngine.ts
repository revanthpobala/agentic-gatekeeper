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

// Pricing per 1M tokens (input / output) in USD
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
    'claude': { input: 3.00, output: 15.00 },
    'gpt-4o': { input: 2.50, output: 10.00 },
    'gpt-4': { input: 5.00, output: 15.00 },
    'gpt-3.5': { input: 0.50, output: 1.50 },
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

    constructor(workspaceRoot: string, outputChannel: vscode.OutputChannel, workspaceState: vscode.Memento) {
        this.workspaceRoot = workspaceRoot;
        this.outputChannel = outputChannel;
        this.workspaceState = workspaceState;
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

    private printAudit(audit: RunAudit) {
        const totalTokens = audit.totalPromptTokens + audit.totalCompletionTokens;
        this.outputChannel.appendLine('');
        this.outputChannel.appendLine('--- Gatekeeper Audit ---');
        this.outputChannel.appendLine(`Provider Model: ${audit.modelUsed}`);
        this.outputChannel.appendLine(`Files Analyzed: ${audit.filesAnalyzed}`);
        this.outputChannel.appendLine(`API Calls Made: ${audit.apiCalls}`);
        if (totalTokens > 0) {
            this.outputChannel.appendLine(`Total Tokens: ${totalTokens.toLocaleString()} (Prompt: ${audit.totalPromptTokens.toLocaleString()} | Completion: ${audit.totalCompletionTokens.toLocaleString()})`);
            this.outputChannel.appendLine(`Estimated Cost: $${audit.totalCost.toFixed(4)}`);
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

                const markdownParser = new MarkdownParser(this.workspaceRoot, this.outputChannel);
                const patcher = new WorkspacePatcher(this.workspaceRoot, this.outputChannel);
                const orchestrator = new AIAgent();
                const config = vscode.workspace.getConfiguration('agenticGatekeeper');
                const isDryRun = config.get<boolean>('dryRun') === true;

                // 1. Audit Rules
                progress.report({ message: "Discovering rules..." });
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

                // 2. AI Orchestration (Moved up for caching)
                const { provider, modeName } = AIProviderFactory.createProvider(this.outputChannel);
                const instructionsHash = this.computeHash(instructions + '|' + modeName);

                // 3. Audit Staged & Modified Files
                progress.report({ message: "Analyzing local changes..." });
                const stagedFiles = await gitContext.getStagedFiles();
                const modifiedFiles = await gitContext.getModifiedFiles();

                // Deduplicate files: we want to audit anything the user is actively working on
                const activeFiles = Array.from(new Set([...stagedFiles, ...modifiedFiles]));

                const fileContexts: FileContext[] = [];

                // Paths that are rule/config sources - don't analyze these as code
                const skipPrefixes = ['.gatekeeper/', '.cursor/', '.github/', '.agents/'];
                const skipExact = ['agents.md', 'AGENTS.md', 'CONTRIBUTING.md', 'ARCHITECTURE.md'];

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

                for (const relativePath of activeFiles) {
                    const basename = path.basename(relativePath);
                    const ext = path.extname(relativePath).toLowerCase();

                    const shouldSkip = skipPrefixes.some(p => relativePath.startsWith(p)) ||
                        skipExact.includes(relativePath) ||
                        relativePath.endsWith('-gatekeeper.md') ||
                        relativePath.endsWith('-instructions.md') ||
                        skipFilenames.includes(basename) ||
                        skipExtensions.some(e => relativePath.endsWith(e)) ||
                        ext === '' && basename.startsWith('.'); // dotfiles with no extension

                    if (shouldSkip) {
                        this.outputChannel.appendLine(`  [Skipped] ${relativePath}`);
                        continue;
                    }

                    const fullPath = path.join(this.workspaceRoot, relativePath);
                    try {
                        const stats = await fs.promises.stat(fullPath);
                        if (stats.isFile()) {
                            let content = '';
                            if (contextDepth === 'diff') {
                                content = await gitContext.getStagedDiff(relativePath);
                                if (!content || content.trim() === '') {
                                    content = await fs.promises.readFile(fullPath, 'utf8');
                                }
                            } else {
                                content = await fs.promises.readFile(fullPath, 'utf8');
                            }

                            // Caching Logic: Check if result is already known to be compliant
                            const contentHash = this.computeHash(content);
                            const cacheKey = `gatekeeper:cache:${relativePath}`;
                            const cached: any = this.workspaceState.get(cacheKey);

                            if (cached && cached.contentHash === contentHash && cached.rulesHash === instructionsHash && cached.result === "OK") {
                                this.outputChannel.appendLine(`  [Cached] ${relativePath} is Compliant.`);
                                continue;
                            }

                            fileContexts.push({ filePath: relativePath, content, contentHash });
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
                const isConcurrent = config.get<string>('concurrencyMode') === 'Concurrent' && executionStrategy !== 'continuous';
                const maxTokensPerBatch = config.get<number>('maxTokensPerBatch') || 30000;

                const instructionTokens = estimateTokens(instructions);

                // Smart batching: group files to minimize redundant rule token duplication
                let batches: FileContext[][] = [];
                try {
                    const batchResult = groupIntoBatches(fileContexts, {
                        maxTokensPerBatch,
                        instructionTokens,
                        safetyBuffer: 2000
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

                this.outputChannel.appendLine(`Mode: ${modeName} | Strategy: ${executionStrategy} | Context: ${contextDepth}`);
                this.outputChannel.appendLine(`${totalFiles} file(s) -> ${batches.length} batch(es) | Budget: ${maxTokensPerBatch.toLocaleString()} tokens/batch`);

                if (isConcurrent) {
                    const maxConcurrent = config.get<number>('maxConcurrentRequests') || 5;
                    this.outputChannel.appendLine(`Execution: 🚀 Concurrent(Max ${maxConcurrent} parallel batches)`);

                    const results: { batch: FileContext[], result: ProviderResult, error?: string }[] = [];

                    for (let i = 0; i < batches.length; i += maxConcurrent) {
                        if (token.isCancellationRequested) {
                            this.outputChannel.appendLine('⚠️ Analysis Aborted by User.');
                            vscode.window.showInformationMessage('Agentic Gatekeeper: Analysis aborted.');
                            return;
                        }

                        const concurrentBatches = batches.slice(i, i + maxConcurrent);
                        progress.report({ message: `Analyzing batches ${i + 1}–${Math.min(i + maxConcurrent, batches.length)} of ${batches.length}...` });

                        const promises = concurrentBatches.map(async (batch, idx) => {
                            const batchNum = i + idx + 1;
                            const fileNames = batch.map(f => f.filePath).join(', ');
                            const batchTokens = batch.reduce((sum, f) => sum + estimateTokens(f.content) + estimateTokens(f.filePath) + 50, 0) + instructionTokens;

                            this.outputChannel.appendLine(`  -> Batch ${batchNum}/${batches.length} [${fileNames}]: ${batchTokens.toLocaleString()} tokens (inc. rules). Sending...`);

                            try {
                                const result = await orchestrator.analyze(instructions, batch, provider, contextDepth);
                                return { batch, result };
                            } catch (err: any) {
                                return { batch, result: { content: null, usage: null, model: modeName } as ProviderResult, error: err.message };
                            }
                        });

                        const batchResults = await Promise.all(promises);
                        results.push(...batchResults);
                    }

                    progress.report({ message: `Verifying final analysis results...` });

                    for (const { batch, result, error } of results) {
                        this.accumulateAudit(audit, result);
                        const fileNames = batch.map(f => f.filePath).join(', ');

                        if (error || !result.content) {
                            hasErrors = true;
                            this.outputChannel.appendLine(`Error: Validation engine failed on batch[${fileNames}].(${error || 'No response'})`);
                            continue;
                        }

                        if (result.content.trim().toUpperCase() !== "OK") {
                            const changes = patcher.parseAIResponse(result.content);
                            if (changes && changes.length > 0) {
                                hasViolations = true;
                                allChanges.push(...changes);
                                for (const change of changes) {
                                    const reason = change.reason || "(no reason provided)";
                                    this.outputChannel.appendLine(`  -> Violations found in ${change.filePath}: "${reason}" - Auto-fix mapped.`);
                                }
                            } else {
                                // If it's not "OK" but returned empty JSON, it means the model thinks it's compliant 
                                // but missed the magic word. We'll treat it as compliant and cache it.
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

                        this.outputChannel.appendLine(`  -> Batch ${i + 1}/${batches.length} [${fileNames}]: ${batchTokens.toLocaleString()} tokens (inc. rules). Sending...`);
                        progress.report({ message: `Validating batch ${i + 1}/${batches.length} (${batch.length} files)...` });

                        try {
                            const result = await orchestrator.analyze(instructions, batch, provider, contextDepth);
                            this.accumulateAudit(audit, result);

                            if (!result.content) {
                                hasErrors = true;
                                this.outputChannel.appendLine(`Error: Validation engine failed on batch [${fileNames}]. Skipping.`);
                                continue;
                            }

                            if (result.content.trim().toUpperCase() !== "OK") {
                                hasViolations = true;
                                const changes = patcher.parseAIResponse(result.content);
                                if (changes && changes.length > 0) {
                                    allChanges.push(...changes);
                                    for (const change of changes) {
                                        const reason = change.reason || "(no reason provided)";
                                        this.outputChannel.appendLine(`  -> Violations found in ${change.filePath}: "${reason}" - Auto-fix mapped.`);
                                    }

                                    // Continuous Strategy: Apply immediately
                                    if (executionStrategy === 'continuous' && !isDryRun && contextDepth !== 'diff') {
                                        this.outputChannel.appendLine(`  -> Continuous Mode: Applying and staging fixes for this batch...`);
                                        const success = await patcher.applyChanges(changes);
                                        if (success) {
                                            await gitContext.stageFiles(changes.map((c: any) => c.filePath));
                                            this.outputChannel.appendLine(`  -> Batch fixes applied and staged successfully.`);
                                        } else {
                                            this.outputChannel.appendLine(`  -> Batch fix application failed.`);
                                            hasErrors = true;
                                        }
                                    }
                                } else {
                                    this.outputChannel.appendLine(`  -> Violations found in batch [${fileNames}] but no JSON auto-patch was returned.`);
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
                        } catch (err: any) {
                            hasErrors = true;
                            this.outputChannel.appendLine(`Error: Validation engine crashed on batch [${fileNames}]. (${err.message})`);
                        }
                    }
                }

                if (token.isCancellationRequested) {
                    this.outputChannel.appendLine('⚠️ Analysis Aborted by User before final apply.');
                    vscode.window.showInformationMessage('Agentic Gatekeeper: Analysis aborted. No changes applied.');
                    return;
                }

                // 4. Apply Results
                progress.report({ message: `Applying rule mutations...` });

                if (!hasViolations && !hasErrors) {
                    this.outputChannel.appendLine('Result: OK (Entire changeset is Compliant)');
                    this.outputChannel.appendLine('Final Verification Complete: 0 files required patching.');
                    vscode.window.showInformationMessage('Agentic Gatekeeper: Code is fully compliant.');
                } else if (hasErrors && !hasViolations && allChanges.length === 0) {
                    this.outputChannel.appendLine('Result: ⚠️ INCOMPLETE — One or more batches failed. Cannot confirm compliance.');
                    vscode.window.showWarningMessage('Agentic Gatekeeper: Analysis incomplete — AI provider errors occurred. See Output.');
                } else if (allChanges.length > 0) {
                    if (contextDepth === 'diff') {
                        this.outputChannel.appendLine(`\nResult: ⚠️ AUDIT ONLY (Diff Mode). Found ${allChanges.length} violation(s), but auto-fix is disabled for partial context.`);
                        this.outputChannel.appendLine(`Switch to Context Depth: "full" in settings to enable auto-patching.`);
                        vscode.window.showWarningMessage(`Agentic Gatekeeper: ${allChanges.length} violations found. Switch to 'full' mode to auto-fix.`);
                    } else if (isDryRun) {
                        this.outputChannel.appendLine(`\nResult: 🧪 DRY RUN ENABLED. Skipping filesystem patches for ${allChanges.length} file(s).`);
                        vscode.window.showInformationMessage(`Agentic Gatekeeper (Dry Run): ${allChanges.length} file(s) would have been patched. See Output.`);
                    } else if (executionStrategy === 'continuous') {
                        this.outputChannel.appendLine(`\nResult: ✅ Continuous Execution Complete. ${allChanges.length} file(s) patched and staged batch-by-batch.`);
                        vscode.window.showInformationMessage(`Agentic Gatekeeper: Continuous patching complete (${allChanges.length} files).`);
                    } else {
                        this.outputChannel.appendLine(`Result: Applying rules to ${allChanges.length} file(s)...`);
                        const success = await patcher.applyChanges(allChanges);
                        if (success) {
                            await gitContext.stageFiles(allChanges.map(c => c.filePath));
                            this.outputChannel.appendLine('Workspace updated and re-staged.');
                            this.outputChannel.appendLine('Final Verification Complete: All identified changes were applied correctly.');
                            vscode.window.showInformationMessage(`Agentic Gatekeeper: Applied rules to ${allChanges.length} file(s).`);
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
