import { simpleGit, SimpleGit, StatusResult } from 'simple-git';
import * as vscode from 'vscode';


export class GitContext {
    private git: SimpleGit;
    private cachedStatus: StatusResult | null = null;

    constructor(workspaceRoot: string) {
        this.git = simpleGit(workspaceRoot);
    }

    /**
     * Fetches git status once and caches it for the duration of this run.
     */
    private async getStatus(): Promise<StatusResult> {
        if (!this.cachedStatus) {
            this.cachedStatus = await this.git.status();
        }
        return this.cachedStatus;
    }

    /**
     * Gets a list of currently staged files in the git repository.
     */
    public async getStagedFiles(): Promise<string[]> {
        try {
            const status = await this.getStatus();
            return status.staged;
        } catch (error) {
            console.error('Failed to get staged files:', error);
            vscode.window.showErrorMessage('Agentic Gatekeeper: Failed to read Git status.');
            return [];
        }
    }

    /**
     * Gets a list of modified or UNTRACKED (new) files.
     */
    public async getModifiedFiles(): Promise<string[]> {
        try {
            const status = await this.getStatus();
            // Combine tracked modifications with completely untracked new files
            return [...status.modified, ...status.not_added];
        } catch (error) {
            console.error('Failed to get modified or untracked files:', error);
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
