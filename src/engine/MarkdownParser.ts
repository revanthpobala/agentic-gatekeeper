import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { minimatch } from 'minimatch';

// Directories that contain global rules (applied to all files)
const GLOBAL_RULE_DIRS = ['.gatekeeper', '.cursor/rules', '.cursor', '.github', '.agents'];

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
     * Determines if a rule file is global (applies to all files) or domain-specific.
     * Global rules include: files in dot-directories like .gatekeeper, .cursor/rules,
     * root-level files like AGENTS.md, and any file in a recognized config directory.
     */
    private classifyRule(relativePath: string): { type: 'global' | 'domain', domainPath?: string } {

        // Root-level markdown files are always global
        if (!relativePath.includes('/')) {
            return { type: 'global' };
        }

        // Well-known global rule directories
        for (const dir of GLOBAL_RULE_DIRS) {
            if (relativePath.startsWith(dir + '/') || relativePath.startsWith(dir + '\\')) {
                return { type: 'global' };
            }
        }

        // Any dot-directory at the root is treated as global config
        if (relativePath.startsWith('.')) {
            return { type: 'global' };
        }

        // Everything else is domain-specific
        return { type: 'domain', domainPath: path.dirname(relativePath) };
    }

    /**
     * Locates and reads the content of configured Markdown files.
     * Uses two strategies: vscode.workspace.findFiles for standard patterns,
     * and direct filesystem reads for dot-directories that findFiles may skip.
     */
    public async getRuleContext(): Promise<{ filename: string, content: string, type: 'global' | 'domain', domainPath?: string }[]> {
        const rulesContext: { filename: string, content: string, type: 'global' | 'domain', domainPath?: string }[] = [];
        const seenPaths = new Set<string>();
        const patterns = this.targetRulesFiles;

        this.log(`Analyzing workspace for rules using patterns: ${patterns.join(', ')}`);

        for (const pattern of patterns) {
            // For dot-directory patterns, try direct filesystem scan first
            // because findFiles may skip them due to .gitignore / files.exclude
            if (pattern.startsWith('.')) {
                await this.scanDirectPattern(pattern, rulesContext, seenPaths);
            }

            // Also try vscode.workspace.findFiles (works for non-dot patterns, and
            // as a fallback for dot patterns if the direct scan missed anything)
            try {
                const relativePattern = new vscode.RelativePattern(this.workspaceRoot, pattern);
                // Exclude node_modules but allow dot-directories
                const uris = await vscode.workspace.findFiles(relativePattern, '**/node_modules/**');

                for (const uri of uris) {
                    const relativePath = path.relative(this.workspaceRoot, uri.fsPath);
                    if (seenPaths.has(relativePath)) { continue; }
                    seenPaths.add(relativePath);

                    try {
                        const contentBytes = await vscode.workspace.fs.readFile(uri);
                        const content = Buffer.from(contentBytes).toString('utf8');
                        const classification = this.classifyRule(relativePath);
                        const label = classification.type === 'global' ? 'GLOBAL' : `DOMAIN (${classification.domainPath})`;
                        this.log(`  + Found rule [${label}]: ${relativePath}`);

                        rulesContext.push({
                            filename: relativePath,
                            content,
                            type: classification.type,
                            domainPath: classification.domainPath,
                        });
                    } catch (error) {
                        this.log(`  ! Failed to read: ${uri.fsPath}`);
                    }
                }
            } catch {
                // findFiles may throw for invalid patterns — fall through silently
            }
        }

        if (rulesContext.length === 0) {
            this.log('  - No rule files detected.');
        }

        return rulesContext;
    }

    /**
     * Directly scans the filesystem for a glob pattern that starts with a dot-directory.
     * This bypasses vscode.workspace.findFiles which may skip dot-dirs due to ignore rules.
     */
    private async scanDirectPattern(
        pattern: string,
        rulesContext: { filename: string, content: string, type: 'global' | 'domain', domainPath?: string }[],
        seenPaths: Set<string>
    ): Promise<void> {
        // Extract the directory portion from the glob (e.g., ".cursor/rules" from ".cursor/rules/*.md")
        const parts = pattern.split('/');
        let dirParts: string[] = [];
        for (const part of parts) {
            if (part.includes('*') || part.includes('?') || part.includes('{')) { break; }
            dirParts.push(part);
        }

        const dirPath = path.join(this.workspaceRoot, ...dirParts);

        if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
            return;
        }

        // Read all files in the directory and match against the glob
        const entries = this.readDirRecursive(dirPath);
        for (const fullPath of entries) {
            const relativePath = path.relative(this.workspaceRoot, fullPath);
            if (seenPaths.has(relativePath)) { continue; }

            // Skip node_modules
            if (relativePath.includes('node_modules')) { continue; }

            // Check if the file matches the glob pattern
            if (minimatch(relativePath, pattern, { dot: true })) {
                seenPaths.add(relativePath);

                try {
                    const content = fs.readFileSync(fullPath, 'utf8');
                    const classification = this.classifyRule(relativePath);
                    const label = classification.type === 'global' ? 'GLOBAL' : `DOMAIN (${classification.domainPath})`;
                    this.log(`  + Found rule [${label}]: ${relativePath}`);

                    rulesContext.push({
                        filename: relativePath,
                        content,
                        type: classification.type,
                        domainPath: classification.domainPath,
                    });
                } catch {
                    this.log(`  ! Failed to read: ${fullPath}`);
                }
            }
        }
    }

    /**
     * Recursively reads all files in a directory.
     */
    private readDirRecursive(dirPath: string): string[] {
        const results: string[] = [];
        try {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);
                if (entry.isDirectory()) {
                    results.push(...this.readDirRecursive(fullPath));
                } else if (entry.isFile()) {
                    results.push(fullPath);
                }
            }
        } catch {
            // Permission errors, etc — skip silently
        }
        return results;
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
