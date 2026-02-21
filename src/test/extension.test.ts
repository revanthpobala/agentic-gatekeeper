import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

suite('Command Dumper Suite', () => {
	test('Dump ALL commands', async () => {
		const commands = await vscode.commands.getCommands(true);
		const p = path.join(__dirname, '../../../commands-all.txt');
		fs.writeFileSync(p, commands.join('\n'));
		console.log(`Wrote ${commands.length} commands to ${p}`);
	});
});
