import * as vscode from 'vscode';
import * as path from 'path';

export interface FileChange {
    filePath: string;
    reason?: string;
    newContent: string;
}

export class WorkspacePatcher {
    private workspaceRoot: string;
    private outputChannel?: vscode.OutputChannel;

    constructor(workspaceRoot: string, outputChannel?: vscode.OutputChannel) {
        this.workspaceRoot = workspaceRoot;
        this.outputChannel = outputChannel;
    }

    public parseAIResponse(response: string): FileChange[] {
        const raw = response.trim();
        const attempt1 = this.tryParseFileChanges(raw);
        if (attempt1) { return this.filterChanges(attempt1); }

        const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
        if (fenceMatch) {
            const attempt2 = this.tryParseFileChanges(fenceMatch[1].trim());
            if (attempt2) {
                return this.filterChanges(attempt2);
            }
        }

        const firstBracket = raw.indexOf('[');
        const lastBracket = raw.lastIndexOf(']');

        if (firstBracket !== -1 && lastBracket > firstBracket) {
            const attempt3 = this.tryParseFileChanges(raw.slice(firstBracket, lastBracket + 1));
            if (attempt3) { return this.filterChanges(attempt3); }
        }

        this.logChannel(`No valid JSON array found in response: ${raw.slice(0, 50)}...`);
        return [];

    }

    private tryParseFileChanges(text: string): FileChange[] | null {
        try {
            // Basic sanitization: strip trailing commas in arrays/objects
            const sanitized = text
                .replace(/,\s*\]/g, ']')
                .replace(/,\s*\}/g, '}');

            const parsed = JSON.parse(sanitized);
            if (!Array.isArray(parsed)) { return null; }
            // Validate shape of each element
            const valid = parsed.filter(
                (item): item is FileChange =>
                    typeof item === 'object' &&
                    item !== null &&
                    typeof item.filePath === 'string' &&
                    item.filePath.length > 0 &&
                    (item.reason === undefined || typeof item.reason === 'string') &&
                    typeof item.newContent === 'string'
            );
            return valid.length > 0 ? valid : null;
        } catch {
            return null;
        }
    }

    private filterChanges(changes: FileChange[]): FileChange[] {
        const junkPatterns = [
            'full_rewritten_file_content_with_all_fixes',
            '... (actual rewritten file content) ...',
            '// ... existing code ...',
            '// existing code here',
            '// same as before',
            '// same as original',
            '/* ... */',
            'same as above',
        ];

        return changes.filter(change => {
            const content = change.newContent.trim();
            const lowerContent = content.toLowerCase();

            // Reject single-word/short status responses using accurate regex
            if (/^(ok|fixed|compliant|pass|done|no\s+violations?)$/i.test(content)) {
                this.logChannel(`REJECTED ${change.filePath} - content is a status word.`);
                vscode.window.showWarningMessage(
                    `Agentic Gatekeeper: AI returned a status word ("${content}") as file content for ${change.filePath}. Skipping.`
                );
                return false;
            }

            const detectedJunk = junkPatterns.find(p => lowerContent.includes(p));
            if (detectedJunk) {
                this.logChannel(`REJECTED ${change.filePath} - contains placeholder: "${detectedJunk}"`);
                vscode.window.showWarningMessage(
                    `Agentic Gatekeeper: AI returned a placeholder for ${change.filePath}. Skipping to protect your code.`
                );
                return false;
            }

            return true;
        });
    }

    /**
     * Applies full file rewrites to the workspace atomically.
     * Warns if any targeted file has unsaved changes before proceeding.
     */
    public async applyChanges(changes: FileChange[]): Promise<boolean> {
        if (changes.length === 0) { return false; }

        // Resolve and validate all paths upfront
        const resolvedChanges: { change: FileChange; uri: vscode.Uri }[] = [];
        for (const change of changes) {
            const resolvedPath = path.resolve(this.workspaceRoot, change.filePath);
            if (!resolvedPath.startsWith(this.workspaceRoot)) {
                this.logChannel(`BLOCKED path traversal attempt: ${change.filePath}`);
                vscode.window.showWarningMessage(`Agentic Gatekeeper: Blocked unsafe path from AI: ${change.filePath}`);
                continue;
            }
            resolvedChanges.push({ change, uri: vscode.Uri.file(resolvedPath) });
        }

        if (resolvedChanges.length === 0) { return false; }

        // Warn if any file has unsaved changes
        const dirtyFiles = resolvedChanges.filter(({ uri }) => {
            const openDoc = vscode.workspace.textDocuments.find(
                (doc: vscode.TextDocument) => doc.uri.fsPath === uri.fsPath && doc.isDirty
            );
            return !!openDoc;
        });

        if (dirtyFiles.length > 0) {
            const filenames = dirtyFiles.map(f => f.change.filePath).join(', ');
            const choice = await vscode.window.showWarningMessage(
                `Agentic Gatekeeper: ${dirtyFiles.length} file(s) have unsaved changes and will be overwritten: ${filenames}. Proceed?`,
                'Overwrite', 'Cancel'
            );
            if (choice !== 'Overwrite') {
                this.logChannel('Patch cancelled - unsaved changes would be overwritten.');
                return false;
            }
        }

        const edit = new vscode.WorkspaceEdit();

        for (const { change, uri } of resolvedChanges) {
            // Check if the file already exists
            let fileExists = true;
            try {
                await vscode.workspace.fs.stat(uri);
            } catch {
                fileExists = false;
            }

            if (fileExists) {
                try {
                    const document = await vscode.workspace.openTextDocument(uri);
                    const fullRange = new vscode.Range(
                        document.positionAt(0),
                        document.positionAt(document.getText().length)
                    );
                    edit.replace(uri, fullRange, change.newContent);
                } catch (err) {
                    this.logChannel(`Cannot open ${change.filePath}: ${err}`);
                    vscode.window.showWarningMessage(
                        `Agentic Gatekeeper: Cannot patch ${change.filePath} - file is inaccessible. Skipping.`
                    );
                }
            } else {
                edit.createFile(uri, { ignoreIfExists: false });
                edit.insert(uri, new vscode.Position(0, 0), change.newContent);
            }
        }

        const success = await vscode.workspace.applyEdit(edit);

        if (success) {
            for (const { change, uri } of resolvedChanges) {
                try {
                    const document = await vscode.workspace.openTextDocument(uri);
                    await document.save();
                } catch (e) {
                    this.logChannel(`Failed to save ${change.filePath}: ${e}`);
                }
            }
        }

        return success;
    }

    private logChannel(msg: string) {
        this.outputChannel?.appendLine(`[Patcher] ${msg}`);
        console.log(`[WorkspacePatcher] ${msg}`);
    }
}
