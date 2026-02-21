import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { minimatch } from 'minimatch';

export class MarkdownParser {
    private workspaceRoot: string;
    private outputChannel: vscode.OutputChannel | undefined;

    private static readonly DEFAULT_RULES_FILES = [
        '.gatekeeper/*.md',
        '**/*-gatekeeper.md',
        '**/*-instructions.md',
        'agents.md',
        'AGENTS.md',
        'CONTRIBUTING.md',
        'ARCHITECTURE.md'
    ];

    constructor(workspaceRoot: string, outputChannel?: vscode.OutputChannel) {
        this.workspaceRoot = workspaceRoot;
        this.outputChannel = outputChannel;
    }

    private log(msg: string) {
        this.outputChannel?.appendLine(`[Discovery] ${msg}`);
    }

    private get targetRulesFiles(): string[] {
        const config = vscode.workspace.getConfiguration('agenticGatekeeper');
        return config.get<string[]>('rulesFiles') ?? MarkdownParser.DEFAULT_RULES_FILES;
    }

    /**
     * Locates and reads the content of configured Markdown files.
     */
    public async getRuleContext(): Promise<{ filename: string, content: string, type: 'global' | 'domain', domainPath?: string }[]> {
        const rulesContext: { filename: string, content: string, type: 'global' | 'domain', domainPath?: string }[] = [];
        this.log(`Analyzing workspace for rules using patterns: ${this.targetRulesFiles.join(', ')}`);

        for (const pattern of this.targetRulesFiles) {
            const relativePattern = new vscode.RelativePattern(this.workspaceRoot, pattern);
            const uris = await vscode.workspace.findFiles(relativePattern);

            for (const uri of uris) {
                // Avoid duplicates if multiple patterns match the same file
                const relativePath = vscode.workspace.asRelativePath(uri);
                if (rulesContext.some(r => r.filename === relativePath)) { continue; }

                try {
                    const contentBytes = await vscode.workspace.fs.readFile(uri);
                    const content = Buffer.from(contentBytes).toString('utf8');

                    // Classify the rule
                    const isGlobal = relativePath.toLowerCase() === 'agents.md' ||
                        relativePath.toLowerCase() === 'contributing.md' ||
                        relativePath.toLowerCase() === 'architecture.md' ||
                        relativePath.startsWith('.gatekeeper/') ||
                        !relativePath.includes('/'); // Root level files are global

                    const type = isGlobal ? 'global' : 'domain';
                    const domainPath = isGlobal ? undefined : path.dirname(relativePath);

                    const label = isGlobal ? 'GLOBAL' : `DOMAIN (${domainPath})`;
                    this.log(`  + Found rule [${label}]: ${relativePath}`);

                    rulesContext.push({
                        filename: relativePath,
                        content,
                        type,
                        domainPath
                    });
                } catch (error) {
                    this.log(`  ! Failed to read: ${uri.fsPath}`);
                }
            }
        }

        if (rulesContext.length === 0) {
            this.log('  - No rule files detected.');
        }

        return rulesContext;
    }

    /**
     * Consolidates all found instructions into a single string for prompting.
     */
    public async getConsolidatedInstructions(): Promise<string> {
        const rules = await this.getRuleContext();
        if (rules.length === 0) {
            return "No specific instructions found.";
        }

        let output = "";

        const globalRules = rules.filter(r => r.type === 'global');
        if (globalRules.length > 0) {
            output += "### GLOBAL INSTRUCTIONS (Apply to ALL files)\n\n";
            for (const rule of globalRules) {
                output += `--- Source: ${rule.filename} ---\n${rule.content}\n\n`;
            }
        }

        const domainRules = rules.filter(r => r.type === 'domain');
        if (domainRules.length > 0) {
            output += "### DIRECTORY-SPECIFIC INSTRUCTIONS (Apply ONLY to files within the specified Domain Path)\n\n";
            for (const rule of domainRules) {
                output += `--- Source: ${rule.filename} (Domain Path: ${rule.domainPath}/) ---\n${rule.content}\n\n`;
            }
        }

        return output;
    }
}
