import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { GitContext } from './GitContext';
import { MarkdownParser } from './MarkdownParser';
import { AIAgent, FileContext } from '../ai/AIAgent';
import { AIProviderFactory } from '../ai/AIProviderFactory';
import { WorkspacePatcher } from '../applier/WorkspacePatcher';

export class GatekeeperEngine {
    private workspaceRoot: string;
    private outputChannel: vscode.OutputChannel;

    constructor(workspaceRoot: string, outputChannel: vscode.OutputChannel) {
        this.workspaceRoot = workspaceRoot;
        this.outputChannel = outputChannel;
    }

    public async run() {
        this.outputChannel.show(true);
        this.outputChannel.appendLine('\n--- Gatekeeper Protocol Initiated ---');

        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.SourceControl,
                title: "Agentic Gatekeeper",
                cancellable: false
            }, async (progress) => {
                const gitContext = new GitContext(this.workspaceRoot);
                const markdownParser = new MarkdownParser(this.workspaceRoot, this.outputChannel);
                const patcher = new WorkspacePatcher(this.workspaceRoot);
                const orchestrator = new AIAgent();

                // 1. Audit Rules
                progress.report({ message: "Discovering rules..." });
                const instructions = await markdownParser.getConsolidatedInstructions();

                // 2. Audit Staged Files
                progress.report({ message: "Analyzing staged changes..." });
                const stagedFiles = await gitContext.getStagedFiles();
                const fileContexts: FileContext[] = [];

                for (const relativePath of stagedFiles) {
                    const fullPath = path.join(this.workspaceRoot, relativePath);
                    if (fs.existsSync(fullPath)) {
                        const content = fs.readFileSync(fullPath, 'utf8');
                        fileContexts.push({ filePath: relativePath, content });
                    }
                }

                if (fileContexts.length === 0) {
                    this.outputChannel.appendLine('Result: No staged changes found.');
                    vscode.window.showInformationMessage('No staged changes found to analyze.');
                    return;
                }

                // 3. AI Orchestration
                const { provider, modeName } = AIProviderFactory.createProvider(this.outputChannel);

                this.outputChannel.appendLine(`Mode: ${modeName}`);
                progress.report({ message: `Validation: ${modeName}...` });

                const response = await orchestrator.analyze(instructions, fileContexts, provider);

                if (!response) {
                    this.outputChannel.appendLine('Error: Validation engine failed to return a response.');
                    const btn = 'Configure Key';
                    vscode.window.showErrorMessage('Agentic Gatekeeper: Validation failed. No built-in models found.', btn).then(selection => {
                        if (selection === btn) {
                            vscode.commands.executeCommand('agentic-gatekeeper.configureApiKey');
                        }
                    });
                    return;
                }

                // 4. Apply Results
                if (response.trim().toUpperCase() === "COMPLIANT") {
                    this.outputChannel.appendLine('Result: OK (Compliant)');
                    vscode.window.showInformationMessage('Agentic Gatekeeper: Code is fully compliant.');
                } else {
                    const changes = patcher.parseAIResponse(response);
                    if (changes.length > 0) {
                        this.outputChannel.appendLine(`Result: Violations found. Patching ${changes.length} file(s)...`);
                        const success = await patcher.applyChanges(changes);
                        if (success) {
                            await gitContext.stageFiles(changes.map(c => c.filePath));
                            this.outputChannel.appendLine('Workspace patched and re-staged.');
                            vscode.window.showInformationMessage(`Agentic Gatekeeper: Auto-fixed ${changes.length} file(s).`);
                        }
                    } else {
                        this.outputChannel.appendLine('Result: Violations found but no auto-patches available.');
                        this.outputChannel.appendLine(`Report:\n${response}`);
                        vscode.window.showWarningMessage('Agentic Gatekeeper: Rule violations found. See Output for report.');
                    }
                }
            });
        } catch (error: any) {
            const msg = error?.message || String(error);
            this.outputChannel.appendLine(`FATAL ERROR: ${msg}`);
            vscode.window.showErrorMessage(`Agentic Gatekeeper Error: ${msg}`);
        }
    }
}
