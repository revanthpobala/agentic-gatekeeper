import * as vscode from 'vscode';
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

		const engine = new GatekeeperEngine(workspaceFolders[0].uri.fsPath, outputChannel);
		await engine.run();
	});

	const configDisposable = vscode.commands.registerCommand('agentic-gatekeeper.configureApiKey', () => {
		vscode.commands.executeCommand('workbench.action.openSettings', 'agenticGatekeeper');
	});

	context.subscriptions.push(disposable, configDisposable);
}

export function deactivate() { }
