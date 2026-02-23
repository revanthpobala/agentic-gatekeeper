import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import { WorkspacePatcher } from '../../applier/WorkspacePatcher';

suite('WorkspacePatcher Patch Mode Test Suite', () => {
    vscode.window.showInformationMessage('Start all patch tests.');

    const mockRoot = path.join(__dirname, 'mock_workspace');

    // Create a dummy output channel to satisfy the constructor
    const dummyChannel: vscode.OutputChannel = {
        name: 'Dummy',
        append: () => { },
        appendLine: () => { },
        clear: () => { },
        show: () => { },
        hide: () => { },
        dispose: () => { },
        replace: () => { }
    };

    let patcher: WorkspacePatcher;

    setup(() => {
        patcher = new WorkspacePatcher(mockRoot, dummyChannel);
    });

    test('parseAIPatchResponse - Extracts valid JSON patch arrays', () => {
        const payload = `
        Here are the fixes!
        \`\`\`json
        [
            {
                "filePath": "src/test.ts",
                "reason": "Missing semicolon",
                "patches": [
                    {
                        "search": "const x = 5",
                        "replace": "const x = 5;"
                    }
                ]
            }
        ]
        \`\`\`
        `;

        const result = patcher.parseAIPatchResponse(payload);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].filePath, 'src/test.ts');
        assert.strictEqual(result[0].patches[0].replace, 'const x = 5;');
    });

    test('filterPatches - Rejects single word status replacements', () => {
        const patches = [
            {
                filePath: "test.ts",
                patches: [
                    { search: "const x", replace: "OK" },
                    { search: "const y", replace: "const y = 2" }
                ]
            }
        ];

        const filtered = patcher.filterPatches(patches);
        assert.strictEqual(filtered.length, 1); // file array length is 1
        assert.strictEqual(filtered[0].patches.length, 1); // Only const y = 2 survives
        assert.strictEqual(filtered[0].patches[0].replace, "const y = 2");
    });

    test('filterPatches - Rejects empty search strings', () => {
        const patches = [
            {
                filePath: "test.ts",
                patches: [
                    { search: "   ", replace: "const x = 1;" },
                    { search: "const y", replace: "const y = 2;" }
                ]
            }
        ];

        const filtered = patcher.filterPatches(patches);
        assert.strictEqual(filtered[0].patches.length, 1);
        assert.strictEqual(filtered[0].patches[0].search, "const y");
    });
});
