import * as vscode from 'vscode';
import { SyncedRuleEntry } from './RemoteRulesSyncer';

export class RemoteRulesTreeItem extends vscode.TreeItem {
    constructor(
        public readonly entry: SyncedRuleEntry,
    ) {
        super(entry.filename, vscode.TreeItemCollapsibleState.None);
        this.description = entry.sha;
        this.tooltip = new vscode.MarkdownString(
            `**Source:** ${entry.sourceUrl}\n\n**SHA:** \`${entry.sha}\`\n\n**Synced:** ${entry.syncedAt}`
        );
        this.iconPath = new vscode.ThemeIcon('file-symlink-file');
        this.contextValue = 'remoteRuleEntry';
        this.command = {
            command: 'vscode.open',
            title: 'View Local Copy',
            arguments: [vscode.Uri.file(entry.localPath)]
        };
    }
}

export class RemoteRulesTreeProvider implements vscode.TreeDataProvider<RemoteRulesTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<RemoteRulesTreeItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private entries: SyncedRuleEntry[] = [];

    public refresh(entries: SyncedRuleEntry[]): void {
        this.entries = entries;
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: RemoteRulesTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(): RemoteRulesTreeItem[] {
        return this.entries.map(e => new RemoteRulesTreeItem(e));
    }
}
