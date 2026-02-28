import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { minimatch } from 'minimatch';
import { RemoteRulesSyncer } from './RemoteRulesSyncer';

// Directories that contain global rules (applied to all files)
const GLOBAL_RULE_DIRS = ['.gatekeeper', '.cursor/rules', '.cursor', '.github', '.agents'];

export class MarkdownParser {
    private workspaceRoot: string;
    private outputChannel: vscode.OutputChannel | undefined;
    private remoteSync?: RemoteRulesSyncer;

    private static readonly DEFAULT_RULES_FILES = [
        '.gatekeeper/*.md',
        '**/*-gatekeeper.md',
        '**/*-instructions.md',
        'agents.md',
        'AGENTS.md',
        'CONTRIBUTING.md',
        'ARCHITECTURE.md'
    ];

    constructor(workspaceRoot: string, outputChannel?: vscode.OutputChannel, remoteSync?: RemoteRulesSyncer) {
        this.workspaceRoot = workspaceRoot;
        this.outputChannel = outputChannel;
        this.remoteSync = remoteSync;
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
        // Normalize to forward slashes for consistent matching across OSs
        const normalizedPath = relativePath.replace(/\\/g, '/');

        // Root-level markdown files are always global
        if (!normalizedPath.includes('/')) {
            return { type: 'global' };
        }

        // Well-known global rule directories
        for (const dir of GLOBAL_RULE_DIRS) {
            if (normalizedPath.startsWith(dir + '/')) {
                return { type: 'global' };
            }
        }

        // Any dot-directory at the root is treated as global config
        if (normalizedPath.startsWith('.')) {
            return { type: 'global' };
        }

        // Everything else is domain-specific
        return { type: 'domain', domainPath: path.dirname(normalizedPath) };
    }

    private extractFrontmatterGlobs(content: string): string | undefined {
        const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
        if (!fmMatch) return undefined;
        const globsMatch = fmMatch[1].match(/^globs:\s*['"]?(.+?)['"]?\s*$/m);
        return globsMatch ? globsMatch[1].trim() : undefined;
    }

    /**
     * Locates and reads the content of configured Markdown files.
     * Uses two strategies: vscode.workspace.findFiles for standard patterns,
     * and direct filesystem reads for dot-directories that findFiles may skip.
     */
    public async getRuleContext(): Promise<{ filename: string, content: string, type: 'global' | 'domain', domainPath?: string, globs?: string }[]> {
        const rulesContext: { filename: string, content: string, type: 'global' | 'domain', domainPath?: string, globs?: string }[] = [];
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
                            globs: this.extractFrontmatterGlobs(content)
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
            this.log('  - No local rule files detected.');

            // Fallback: attempt remote sync if configured
            if (this.remoteSync) {
                this.log('  🌐 Attempting remote rule sync...');
                try {
                    const synced = await this.remoteSync.sync();
                    for (const entry of synced) {
                        try {
                            const content = await fs.promises.readFile(entry.localPath, 'utf8');
                            rulesContext.push({
                                filename: entry.filename,
                                content,
                                type: 'global',
                                globs: this.extractFrontmatterGlobs(content)
                            });
                        } catch {
                            this.log(`  ! Failed to read synced rule: ${entry.localPath}`);
                        }
                    }
                } catch (err: any) {
                    this.log(`  ✖ Remote sync failed: ${err.message}`);
                }
            }
        }

        return rulesContext;
    }

    /**
     * Directly scans the filesystem for a glob pattern that starts with a dot-directory.
     * This bypasses vscode.workspace.findFiles which may skip dot-dirs due to ignore rules.
     */
    private async scanDirectPattern(
        pattern: string,
        rulesContext: { filename: string, content: string, type: 'global' | 'domain', domainPath?: string, globs?: string }[],
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

        let isDir = false;
        try { isDir = (await fs.promises.stat(dirPath)).isDirectory(); } catch {/* not found */ }
        if (!isDir) {
            return;
        }

        // Read all files in the directory and match against the glob
        const entries = await this.readDirRecursive(dirPath);
        for (const fullPath of entries) {
            const relativePath = path.relative(this.workspaceRoot, fullPath);
            if (seenPaths.has(relativePath)) { continue; }

            // Skip node_modules
            if (relativePath.includes('node_modules')) { continue; }

            // Check if the file matches the glob pattern
            if (minimatch(relativePath, pattern, { dot: true })) {
                seenPaths.add(relativePath);

                try {
                    const content = await fs.promises.readFile(fullPath, 'utf8');
                    const classification = this.classifyRule(relativePath);
                    const label = classification.type === 'global' ? 'GLOBAL' : `DOMAIN (${classification.domainPath})`;
                    this.log(`  + Found rule [${label}]: ${relativePath}`);

                    rulesContext.push({
                        filename: relativePath,
                        content,
                        type: classification.type,
                        domainPath: classification.domainPath,
                        globs: this.extractFrontmatterGlobs(content)
                    });
                } catch {
                    this.log(`  ! Failed to read: ${fullPath}`);
                }
            }
        }
    }

    /**
     * Recursively reads all files in a directory using async IO.
     */
    private async readDirRecursive(dirPath: string): Promise<string[]> {
        const results: string[] = [];
        try {
            const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);
                if (entry.isDirectory()) {
                    results.push(...await this.readDirRecursive(fullPath));
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
     * Consolidates rules into a single string for prompting.
     * Accepts pre-fetched rules or fetches them if not provided.
     */
    public async getConsolidatedInstructions(
        preloaded?: { filename: string, content: string, type: 'global' | 'domain', domainPath?: string, globs?: string }[]
    ): Promise<string> {
        const rules = preloaded ?? await this.getRuleContext();
        if (rules.length === 0) {
            return "No specific instructions found.";
        }

        let output = "";

        const globalRules = rules.filter(r => r.type === 'global');
        if (globalRules.length > 0) {
            output += "### GLOBAL INSTRUCTIONS (APPLY TO EVERY FILE)\n\n";
            for (const rule of globalRules) {
                output += `[[ GLOBAL RULE: ${rule.filename} ]]\n${rule.content}\n\n`;
            }
        }

        const domainRules = rules.filter(r => r.type === 'domain');
        if (domainRules.length > 0) {
            output += "### DOMAIN-SPECIFIC INSTRUCTIONS (APPLY ONLY TO TARGET DIRECTORY)\n\n";
            for (const rule of domainRules) {
                output += `[[ DOMAIN RULE (Path: ${rule.domainPath}/): ${rule.filename} ]]\n${rule.content}\n\n`;
            }
        }

        return output;
    }
}
