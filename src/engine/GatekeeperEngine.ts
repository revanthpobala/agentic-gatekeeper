import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { GitContext } from './GitContext';
import { MarkdownParser } from './MarkdownParser';
import { AIAgent, FileContext } from '../ai/AIAgent';
import { AIProviderFactory } from '../ai/AIProviderFactory';
import { WorkspacePatcher } from '../applier/WorkspacePatcher';
import { TokenUsage, ProviderResult } from '../ai/IProvider';

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
        audit.filesAnalyzed++;
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

                for (const relativePath of activeFiles) {
                    const fullPath = path.join(this.workspaceRoot, relativePath);
                    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
                        const content = fs.readFileSync(fullPath, 'utf8');
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
                const config = vscode.workspace.getConfiguration('agenticGatekeeper');
                const isConcurrent = config.get<string>('concurrencyMode') === 'Concurrent';

                const allChanges = [];
                let hasViolations = false;

                const audit: RunAudit = {
                    totalPromptTokens: 0,
                    totalCompletionTokens: 0,
                    totalCost: 0,
                    filesAnalyzed: 0,
                    modelUsed: modeName,
                };

                if (isConcurrent) {
                    const maxConcurrent = config.get<number>('maxConcurrentRequests') || 5;
                    this.outputChannel.appendLine(`Mode: ${modeName} [🚀 Concurrent Execution - Max ${maxConcurrent} Threads]`);

                    const results: { fileCtx: FileContext, result: ProviderResult, error?: string }[] = [];

                    for (let i = 0; i < fileContexts.length; i += maxConcurrent) {
                        if (token.isCancellationRequested) {
                            this.outputChannel.appendLine('⚠️ Analysis Aborted by User.');
                            vscode.window.showInformationMessage('Agentic Gatekeeper: Analysis aborted.');
                            return;
                        }

                        const batch = fileContexts.slice(i, i + maxConcurrent);
                        progress.report({ message: `Spinning up analysis... (Batch ${Math.floor(i / maxConcurrent) + 1} of ${Math.ceil(fileContexts.length / maxConcurrent)})` });

                        const promises = batch.map(async (fileCtx) => {
                            try {
                                const result = await orchestrator.analyze(instructions, [fileCtx], provider);
                                return { fileCtx, result };
                            } catch (err: any) {
                                return { fileCtx, result: { content: null, usage: null, model: modeName } as ProviderResult, error: err.message };
                            }
                        });

                        const batchResults = await Promise.all(promises);
                        results.push(...batchResults);
                    }

                    progress.report({ message: `Verifying final analysis results...` });

                    for (const { fileCtx, result, error } of results) {
                        this.accumulateAudit(audit, result);

                        if (error || !result.content) {
                            this.outputChannel.appendLine(`Error: Validation engine failed on ${fileCtx.filePath}. (${error || 'No response'})`);
                            continue;
                        }

                        if (result.content.trim().toUpperCase() !== "COMPLIANT") {
                            hasViolations = true;
                            const changes = patcher.parseAIResponse(result.content);
                            if (changes.length > 0) {
                                allChanges.push(...changes);
                                this.outputChannel.appendLine(`  -> Violations found in ${fileCtx.filePath}. Auto-fix mapped.`);
                            } else {
                                this.outputChannel.appendLine(`  -> Violations found in ${fileCtx.filePath} but no JSON auto-patch was returned.`);
                                this.outputChannel.appendLine(`Report:\n${result.content}`);
                            }
                        } else {
                            this.outputChannel.appendLine(`  -> ${fileCtx.filePath} is Compliant.`);
                        }
                    }

                } else {
                    this.outputChannel.appendLine(`Mode: ${modeName} [🛡️ Sequential Execution]`);

                    // Process each file sequentially to avoid context window overflow
                    for (let i = 0; i < fileContexts.length; i++) {
                        if (token.isCancellationRequested) {
                            this.outputChannel.appendLine('⚠️ Analysis Aborted by User.');
                            vscode.window.showInformationMessage('Agentic Gatekeeper: Analysis aborted.');
                            return;
                        }

                        const fileCtx = fileContexts[i];
                        progress.report({ message: `Validating ${i + 1}/${fileContexts.length}: ${fileCtx.filePath}...` });

                        try {
                            const result = await orchestrator.analyze(instructions, [fileCtx], provider);
                            this.accumulateAudit(audit, result);

                            if (!result.content) {
                                this.outputChannel.appendLine(`Error: Validation engine failed on ${fileCtx.filePath}. Skipping.`);
                                continue;
                            }

                            if (result.content.trim().toUpperCase() !== "COMPLIANT") {
                                hasViolations = true;
                                const changes = patcher.parseAIResponse(result.content);
                                if (changes.length > 0) {
                                    allChanges.push(...changes);
                                    this.outputChannel.appendLine(`  -> Violations found in ${fileCtx.filePath}. Auto-fix mapped.`);
                                } else {
                                    this.outputChannel.appendLine(`  -> Violations found in ${fileCtx.filePath} but no JSON auto-patch was returned.`);
                                    this.outputChannel.appendLine(`Report:\n${result.content}`);
                                }
                            } else {
                                this.outputChannel.appendLine(`  -> ${fileCtx.filePath} is Compliant.`);
                            }
                        } catch (err: any) {
                            this.outputChannel.appendLine(`Error: Validation engine crashed on ${fileCtx.filePath}. (${err.message})`);
                        }
                    }
                }

                if (token.isCancellationRequested) {
                    this.outputChannel.appendLine('⚠️ Analysis Aborted by User before final apply.');
                    vscode.window.showInformationMessage('Agentic Gatekeeper: Analysis aborted. No changes applied.');
                    return;
                }

                // 4. Apply Results
                const isDryRun = config.get<boolean>('dryRun') === true;
                progress.report({ message: `Applying rule mutations...` });

                if (!hasViolations) {
                    this.outputChannel.appendLine('Result: OK (Entire changeset is Compliant)');
                    this.outputChannel.appendLine('Final Verification Complete: 0 files required patching.');
                    vscode.window.showInformationMessage('Agentic Gatekeeper: Code is fully compliant.');
                } else if (allChanges.length > 0) {
                    if (isDryRun) {
                        this.outputChannel.appendLine(`\nResult: 🧪 DRY RUN ENABLED. Skipping filesystem patches for ${allChanges.length} file(s).`);
                        vscode.window.showInformationMessage(`Agentic Gatekeeper (Dry Run): ${allChanges.length} file(s) would have been patched. See Output.`);
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
