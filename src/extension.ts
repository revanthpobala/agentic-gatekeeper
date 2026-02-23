import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { GatekeeperEngine } from './engine/GatekeeperEngine';

export function activate(context: vscode.ExtensionContext) {

	console.log('Agentic Gatekeeper is now active.');
	// Create diagnostic output channel
	const outputChannel = vscode.window.createOutputChannel('Agentic Gatekeeper');
	outputChannel.appendLine('Agentic Gatekeeper extension activated.');

	const disposable = vscode.commands.registerCommand('agentic-gatekeeper.analyzeStaged', async () => {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders) {
			vscode.window.showErrorMessage('Agentic Gatekeeper requires an open workspace.');
			return;
		}

		const engine = new GatekeeperEngine(workspaceFolders[0].uri.fsPath, outputChannel, context.workspaceState);
		await engine.run();
	});

	const clearCacheDisposable = vscode.commands.registerCommand('agentic-gatekeeper.clearCache', () => {
		const keys = context.workspaceState.keys().filter(k => k.startsWith('gatekeeper:cache:'));
		for (const key of keys) {
			context.workspaceState.update(key, undefined);
		}
		outputChannel.appendLine('Result Cache Cleared.');
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

	context.subscriptions.push(disposable, clearCacheDisposable, configDisposable, setupDisposable);
}

export function deactivate() { }
