import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import { MarkdownParser } from '../../engine/MarkdownParser';

suite('MarkdownParser Test Suite', () => {

    // Simple test to ensure the parser initializes and exposes its public methods
    test('MarkdownParser instance', () => {
        const parser = new MarkdownParser(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '');
        assert.ok(typeof parser.getRuleContext === 'function');
        assert.ok(typeof parser.getConsolidatedInstructions === 'function');
    });

    // Validates the logic that consolidates rules
    test('Consolidated rules formatting', async () => {
        const parser = new MarkdownParser(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '');

        parser.getRuleContext = async (): Promise<{ filename: string, content: string, type: 'global' | 'domain', domainPath?: string }[]> => {
            return [
                { filename: 'AGENTS.md', content: 'Rule 1: Be nice.', type: 'global' },
                { filename: 'docs/rules.md', content: 'Rule 2: Be fast.', type: 'domain', domainPath: 'docs' }
            ];
        };

        const result = await parser.getConsolidatedInstructions();
        assert.ok(result.includes('[[ GLOBAL RULE: AGENTS.md ]]'));
        assert.ok(result.includes('Rule 1: Be nice.'));
        assert.ok(result.includes('[[ DOMAIN RULE (Path: docs/): docs/rules.md ]]'));
        assert.ok(result.includes('Rule 2: Be fast.'));
    });
});
