import * as vscode from 'vscode';
import * as path from 'path';

export interface FileChange {
    filePath: string;
    newContent: string;
}

export class WorkspacePatcher {
    private workspaceRoot: string;

    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
    }

    /**
     * Attempts to parse a JSON block from the LLM containing { "filePath": "...", "newContent": "..." }
     */
    public parseAIResponse(response: string): FileChange[] {
        try {
            // Improved extraction: Handle markdown JSON blocks if present
            const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || response.match(/\[\s*\{[\s\S]*\}\s*\]/);
            const jsonText = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : null;

            if (jsonText) {
                const parsed = JSON.parse(jsonText.trim()) as FileChange[];
                console.log("Patcher Successfully Extracted JSON:", JSON.stringify(parsed, null, 2));
                return parsed;
            } else {
                console.error("Patcher: No JSON array match found in response:", response);
            }
        } catch (error) {
            console.error("Failed to parse AI response into FileChanges", error);
            console.error("Raw Response was:", response);
        }
        return [];
    }

    /**
     * Automatically applies full file rewrites to the workspace atomically.
     */
    public async applyChanges(changes: FileChange[]): Promise<boolean> {
        if (changes.length === 0) { return false; }

        const edit = new vscode.WorkspaceEdit();

        for (const change of changes) {
            console.log(`Patcher: Attempting to patch file URI: ${change.filePath}`);
            const fileUri = vscode.Uri.file(path.join(this.workspaceRoot, change.filePath));

            try {
                const document = await vscode.workspace.openTextDocument(fileUri);
                const fullRange = new vscode.Range(
                    document.positionAt(0),
                    document.positionAt(document.getText().length)
                );
                edit.replace(fileUri, fullRange, change.newContent);
                console.log(`Patcher: Set edit.replace for ${change.filePath}`);
            } catch (err) {
                // Handle new file creation
                console.warn(`Patcher: File did not exist natively, creating: ${change.filePath}`);
                edit.createFile(fileUri, { ignoreIfExists: true });
                edit.insert(fileUri, new vscode.Position(0, 0), change.newContent);
            }
        }

        // Apply all modifications as a single atomic transaction
        const success = await vscode.workspace.applyEdit(edit);

        if (success) {
            // Save all affected documents to ensure they are ready for git staging
            for (const change of changes) {
                try {
                    const fileUri = vscode.Uri.file(path.join(this.workspaceRoot, change.filePath));
                    const document = await vscode.workspace.openTextDocument(fileUri);
                    await document.save();
                } catch (e) {
                    console.error(`Patcher: Failed to save ${change.filePath}`, e);
                }
            }
        }

        return success;
    }
}
