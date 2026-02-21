import { simpleGit, SimpleGit } from 'simple-git';
import * as vscode from 'vscode';
import * as path from 'path';

export class GitContext {
    private git: SimpleGit;

    constructor(workspaceRoot: string) {
        this.git = simpleGit(workspaceRoot);
    }

    /**
     * Gets a list of currently staged files in the git repository.
     */
    public async getStagedFiles(): Promise<string[]> {
        try {
            const status = await this.git.status();
            return status.staged;
        } catch (error) {
            console.error('Failed to get staged files:', error);
            vscode.window.showErrorMessage('Agentic Gatekeeper: Failed to read Git status.');
            return [];
        }
    }

    /**
     * Gets the diff for the staged changes
     */
    public async getStagedDiff(): Promise<string> {
        try {
            return await this.git.diff(['--cached']);
        } catch (error) {
            console.error('Failed to get staged diff:', error);
            vscode.window.showErrorMessage('Agentic Gatekeeper: Failed to read Git diff.');
            return '';
        }
    }

    /**
     * Re-stages specific files after the agent has auto-fixed them.
     */
    public async stageFiles(filePaths: string[]): Promise<void> {
        try {
            await this.git.add(filePaths);
        } catch (error) {
            console.error('Failed to stage files:', error);
            vscode.window.showErrorMessage('Agentic Gatekeeper: Failed to re-stage fixed files.');
        }
    }
}
