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

    constructor(workspaceRoot: string, outputChannel: vscode.OutputChannel) {
        this.workspaceRoot = workspaceRoot;
        this.outputChannel = outputChannel;
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
                const markdownParser = new MarkdownParser(this.workspaceRoot, this.outputChannel);
                const patcher = new WorkspacePatcher(this.workspaceRoot);
                const orchestrator = new AIAgent();
                const config = vscode.workspace.getConfiguration('agenticGatekeeper');
                const isDryRun = config.get<boolean>('dryRun') === true;

                // 1. Audit Rules
                progress.report({ message: "Discovering rules..." });
                const instructions = await markdownParser.getConsolidatedInstructions();

                // 2. Audit Staged & Modified Files
                progress.report({ message: "Analyzing local changes..." });
                const stagedFiles = await gitContext.getStagedFiles();
                const modifiedFiles = await gitContext.getModifiedFiles();

                // Deduplicate files: we want to audit anything the user is actively working on
                const activeFiles = Array.from(new Set([...stagedFiles, ...modifiedFiles]));

                const fileContexts: FileContext[] = [];

                // Paths that are rule/config sources — don't analyze these as code
                const skipPrefixes = ['.gatekeeper/', '.cursor/', '.github/', '.agents/'];
                const skipExact = ['agents.md', 'AGENTS.md', 'CONTRIBUTING.md', 'ARCHITECTURE.md'];

                const contextDepth = config.get<string>('contextDepth') || 'full';

                for (const relativePath of activeFiles) {
                    // Skip rule files — they are instructions, not code to audit
                    const shouldSkip = skipPrefixes.some(p => relativePath.startsWith(p)) ||
                        skipExact.includes(relativePath) ||
                        relativePath.endsWith('-gatekeeper.md') ||
                        relativePath.endsWith('-instructions.md');

                    if (shouldSkip) {
                        this.outputChannel.appendLine(`  [Rule Source] ${relativePath} (Honored as instruction; skipping code analysis)`);
                        continue;
                    }

                    const fullPath = path.join(this.workspaceRoot, relativePath);
                    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
                        let content = '';
                        if (contextDepth === 'diff') {
                            content = await gitContext.getStagedDiff(relativePath);
                            // If it's a new file, the staged diff is the whole file, but if it's untracked, 
                            // we might need to fallback to reading the file if the diff is empty.
                            if (!content || content.trim() === '') {
                                content = fs.readFileSync(fullPath, 'utf8');
                            }
                        } else {
                            content = fs.readFileSync(fullPath, 'utf8');
                        }
                        fileContexts.push({ filePath: relativePath, content });
                    }
                }

                if (fileContexts.length === 0) {
                    this.outputChannel.appendLine('Result: No local changes found.');
                    vscode.window.showInformationMessage('No active changes found to analyze. Please modify a file first.');
                    return;
                }

                // 3. AI Orchestration
                const { provider, modeName } = AIProviderFactory.createProvider(this.outputChannel);
                const executionStrategy = config.get<string>('executionStrategy') || 'aggregated';
                const isConcurrent = config.get<string>('concurrencyMode') === 'Concurrent' && executionStrategy !== 'continuous';
                const maxTokensPerBatch = config.get<number>('maxTokensPerBatch') || 30000;

                // Smart batching: group files to minimize redundant rule token duplication
                let batches: FileContext[][] = [];
                try {
                    const instructionTokens = estimateTokens(instructions);
                    batches = groupIntoBatches(fileContexts, {
                        maxTokensPerBatch,
                        instructionTokens,
                        safetyBuffer: 2000
                    });
                } catch (batchError: any) {
                    this.outputChannel.appendLine(`Fatal Batching Error: ${batchError.message}`);
                    vscode.window.showErrorMessage(`Agentic Gatekeeper: ${batchError.message}`);
                    return;
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
                            const batchTokens = batch.reduce((sum, f) => sum + estimateTokens(f.content) + estimateTokens(f.filePath) + 50, 0);

                            this.outputChannel.appendLine(`  -> Batch ${batchNum}/${batches.length} [${fileNames}]: ${batchTokens.toLocaleString()} tokens. Sending...`);

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

                        if (result.content.trim().toUpperCase() !== "COMPLIANT") {
                            const changes = patcher.parseAIResponse(result.content);
                            if (changes.length > 0) {
                                hasViolations = true;
                                allChanges.push(...changes);
                                for (const change of changes) {
                                    this.outputChannel.appendLine(`  -> Violations found in ${change.filePath}. Auto-fix mapped.`);
                                }
                            } else {
                                // If it's not "COMPLIANT" but returned empty JSON, it means the model thinks it's compliant 
                                // but missed the magic word. We'll treat it as compliant to avoid confusing the user.
                                for (const f of batch) {
                                    this.outputChannel.appendLine(`  -> ${f.filePath} is Compliant.`);
                                }
                            }
                        } else {
                            for (const f of batch) {
                                this.outputChannel.appendLine(`  -> ${f.filePath} is Compliant.`);
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
                        const batchTokens = batch.reduce((sum, f) => sum + estimateTokens(f.content) + estimateTokens(f.filePath) + 50, 0);

                        this.outputChannel.appendLine(`  -> Batch ${i + 1}/${batches.length} [${fileNames}]: ${batchTokens.toLocaleString()} tokens. Sending...`);
                        progress.report({ message: `Validating batch ${i + 1}/${batches.length} (${batch.length} files)...` });

                        try {
                            const result = await orchestrator.analyze(instructions, batch, provider, contextDepth);
                            this.accumulateAudit(audit, result);

                            if (!result.content) {
                                hasErrors = true;
                                this.outputChannel.appendLine(`Error: Validation engine failed on batch [${fileNames}]. Skipping.`);
                                continue;
                            }

                            if (result.content.trim().toUpperCase() !== "COMPLIANT") {
                                hasViolations = true;
                                const changes = patcher.parseAIResponse(result.content);
                                if (changes.length > 0) {
                                    allChanges.push(...changes);
                                    for (const change of changes) {
                                        this.outputChannel.appendLine(`  -> Violations found in ${change.filePath}. Auto-fix mapped.`);
                                    }

                                    // Continuous Strategy: Apply immediately
                                    if (executionStrategy === 'continuous' && !isDryRun && contextDepth !== 'diff') {
                                        this.outputChannel.appendLine(`  -> Continuous Mode: Applying and staging fixes for this batch...`);
                                        const success = await patcher.applyChanges(changes);
                                        if (success) {
                                            await gitContext.stageFiles(changes.map(c => c.filePath));
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
                                }
                            }
                        } catch (err: any) {
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
