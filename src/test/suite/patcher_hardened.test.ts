import * as assert from 'assert';
import { WorkspacePatcher } from '../../applier/WorkspacePatcher';

suite('WorkspacePatcher Hardened Parsing Test Suite', () => {
    const patcher = new WorkspacePatcher('/mock/root');

    test('parseAIResponse: should reject status words in JSON newContent', () => {
        const response = JSON.stringify([
            {
                filePath: 'test.ts',
                reason: 'Violation',
                newContent: 'OK'
            }
        ]);
        const changes = patcher.parseAIResponse(response);
        assert.strictEqual(changes.length, 0, 'Should have rejected status word as content');
    });

    test('parseAIResponse: should reject common placeholders/junk', () => {
        const junkContent = '// ... existing code ...\nconst x = 1;';
        const response = JSON.stringify([
            {
                filePath: 'test.ts',
                reason: 'Violation',
                newContent: junkContent
            }
        ]);
        const changes = patcher.parseAIResponse(response);
        assert.strictEqual(changes.length, 0, 'Should have rejected placeholder content');
    });

    test('parseAIResponse: should validate JSON shape strictly', () => {
        const malformed = JSON.stringify([
            {
                filePath: '', // Empty path
                newContent: 'Valid'
            },
            {
                filePath: 'test.ts',
                // missing newContent
            }
        ]);
        const changes = patcher.parseAIResponse(malformed);
        assert.strictEqual(changes.length, 0, 'Should have rejected malformed objects');
    });

    test('parseAIResponse: should accept valid reason and content', () => {
        const response = JSON.stringify([
            {
                filePath: 'test.ts',
                reason: 'Rule 1 violation',
                newContent: 'const x = 2;'
            }
        ]);
        const changes = patcher.parseAIResponse(response);
        assert.strictEqual(changes.length, 1);
        assert.strictEqual(changes[0].reason, 'Rule 1 violation');
    });
});
