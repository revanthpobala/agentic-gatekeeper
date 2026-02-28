import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { GatekeeperEngine } from './engine/GatekeeperEngine';
import { RemoteRulesSyncer } from './engine/RemoteRulesSyncer';
import { RemoteRulesTreeProvider } from './engine/RemoteRulesTreeProvider';
import { RuleValidator } from './engine/RuleValidator';

export function activate(context: vscode.ExtensionContext) {

	console.log('Agentic Gatekeeper is now active.');
	const outputChannel = vscode.window.createOutputChannel('Agentic Gatekeeper');
	outputChannel.appendLine('Agentic Gatekeeper extension activated.');

	// --- Remote Rules Syncer + TreeView ---
	const syncer = new RemoteRulesSyncer(
		vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '',
		context.workspaceState,
		outputChannel,
		context.secrets
	);

	const treeProvider = new RemoteRulesTreeProvider();
	const treeView = vscode.window.createTreeView('agenticGatekeeper.remoteRules', {
		treeDataProvider: treeProvider,
		showCollapseAll: false,
	});
	// Seed TreeView with any already-cached entries on activation
	treeProvider.refresh(syncer.getCachedEntries());
	context.subscriptions.push(treeView);

	// --- Commands ---
	const disposable = vscode.commands.registerCommand('agentic-gatekeeper.analyzeStaged', async () => {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders) {
			vscode.window.showErrorMessage('Agentic Gatekeeper requires an open workspace.');
			return;
		}

		const engine = new GatekeeperEngine(workspaceFolders[0].uri.fsPath, outputChannel, context.workspaceState, syncer);
		await engine.run();

		// Refresh TreeView after each run in case remote rules were freshly synced
		treeProvider.refresh(syncer.getCachedEntries());
	});

	const clearCacheDisposable = vscode.commands.registerCommand('agentic-gatekeeper.clearCache', () => {
		const keys = context.workspaceState.keys().filter(k => k.startsWith('gatekeeper:cache:'));
		for (const key of keys) {
			context.workspaceState.update(key, undefined);
		}
		syncer.clearCache();
		treeProvider.refresh([]);
		outputChannel.appendLine('Result Cache + Remote Rules Cache Cleared.');
		vscode.window.showInformationMessage('Agentic Gatekeeper: Result cache cleared.');
	});

	const configDisposable = vscode.commands.registerCommand('agentic-gatekeeper.configureApiKey', () => {
		vscode.commands.executeCommand('workbench.action.openSettings', 'agenticGatekeeper');
	});

	const setupDisposable = vscode.commands.registerCommand('agentic-gatekeeper.setupInstructions', async () => {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders) {
			vscode.window.showErrorMessage('Agentic Gatekeeper requires an open workspace.');
			return;
		}

		const rootPath = workspaceFolders[0].uri.fsPath;
		const gatekeeperDir = path.join(rootPath, '.gatekeeper');
		const rulesFilePath = path.join(gatekeeperDir, 'global-rules.md');

		try {
			if (!fs.existsSync(gatekeeperDir)) {
				fs.mkdirSync(gatekeeperDir, { recursive: true });
			}

			if (!fs.existsSync(rulesFilePath)) {
				const template = `# Global Rules\n\nWrite your instructions here. For example:\n\n1. Always use strict types.\n2. Never use \`any\`.\n3. Add JSDoc comments to all exported functions.\n`;
				fs.writeFileSync(rulesFilePath, template, 'utf8');
			}
		} catch (err: any) {
			vscode.window.showErrorMessage(`Agentic Gatekeeper: Failed to setup rules: ${err.message}`);
			return;
		}

		const document = await vscode.workspace.openTextDocument(rulesFilePath);
		await vscode.window.showTextDocument(document);
	});

	const syncRemoteDisposable = vscode.commands.registerCommand('agentic-gatekeeper.syncRemoteRules', async () => {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders) {
			vscode.window.showErrorMessage('Agentic Gatekeeper requires an open workspace.');
			return;
		}
		outputChannel.show(true);
		outputChannel.appendLine('\n[Manual] Remote Rules Sync triggered...');
		const entries = await syncer.sync(/* force= */ true);
		treeProvider.refresh(entries);
		if (entries.length > 0) {
			vscode.window.showInformationMessage(`Agentic Gatekeeper: Synced ${entries.length} remote rule(s).`);
		} else {
			vscode.window.showWarningMessage('Agentic Gatekeeper: No remote rules configured or fetched. Check agenticGatekeeper.remoteRulesUrl / remoteRulesRepo settings.');
		}
	});

	const openSourceDisposable = vscode.commands.registerCommand('agentic-gatekeeper.openRuleSource', (item) => {
		if (item?.entry?.sourceUrl) {
			vscode.env.openExternal(vscode.Uri.parse(item.entry.sourceUrl));
		}
	});

	const setPatDisposable = vscode.commands.registerCommand('agentic-gatekeeper.setGitHubPat', async () => {
		const pat = await vscode.window.showInputBox({
			prompt: 'Enter your GitHub Personal Access Token (for private repo rule sync)',
			password: true,
			placeHolder: 'ghp_...'
		});
		if (pat) {
			await context.secrets.store('agenticGatekeeper.githubPat', pat);
			vscode.window.showInformationMessage('Agentic Gatekeeper: GitHub PAT saved securely.');
		}
	});

	const validateRulesDisposable = vscode.commands.registerCommand('agentic-gatekeeper.validateRules', async () => {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders) {
			vscode.window.showErrorMessage('Agentic Gatekeeper requires an open workspace.');
			return;
		}
		const validator = new RuleValidator(workspaceFolders[0].uri.fsPath, outputChannel);
		await validator.run();
	});

	const refreshRemoteRulesDisposable = vscode.commands.registerCommand('agentic-gatekeeper.refreshRemoteRules', async () => {
		outputChannel.appendLine('\n[Manual] Remote Rules Refresh triggered...');
		const entries = await syncer.sync(/* force= */ true);
		treeProvider.refresh(entries);
	});

	context.subscriptions.push(
		disposable,
		clearCacheDisposable,
		configDisposable,
		setupDisposable,
		syncRemoteDisposable,
		openSourceDisposable,
		setPatDisposable,
		validateRulesDisposable,
		refreshRemoteRulesDisposable
	);
}

export function deactivate() { }
