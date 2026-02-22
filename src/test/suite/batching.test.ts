import * as assert from 'assert';
import { groupIntoBatches, estimateTokens, BatchConstraints } from '../../engine/BatchProcessor';
import { FileContext } from '../../ai/AIAgent';

suite('BatchProcessor Test Suite', () => {

    test('estimateTokens: should correctly estimate tokens (4 chars/token)', () => {
        assert.strictEqual(estimateTokens('abcd'), 1);
        assert.strictEqual(estimateTokens('abcdefgh'), 2);
        assert.strictEqual(estimateTokens(''), 0);
    });

    test('groupIntoBatches: should group multiple small files into one batch', () => {
        const files: FileContext[] = [
            { filePath: 'file1.ts', content: 'content1' },
            { filePath: 'file2.ts', content: 'content2' }
        ];
        const constraints: BatchConstraints = {
            maxTokensPerBatch: 1000,
            instructionTokens: 100
        };
        const batches = groupIntoBatches(files, constraints);
        assert.strictEqual(batches.length, 1);
        assert.strictEqual(batches[0].length, 2);
    });

    test('groupIntoBatches: should split files into multiple batches if budget is exceeded', () => {
        const files: FileContext[] = [
            { filePath: 'file1.ts', content: 'a'.repeat(400) }, // ~100 tokens
            { filePath: 'file2.ts', content: 'b'.repeat(400) }  // ~100 tokens
        ];
        const constraints: BatchConstraints = {
            maxTokensPerBatch: 300,
            instructionTokens: 50,
            safetyBuffer: 10 // Very small safety buffer for testing
        };
        // Effective budget = 300 - 50 - 10 = 240 tokens.
        // File 1 tokens = 100 + 8 (path) + 50 (delim) = 158 tokens.
        // Adding File 2 (158 tokens) would exceed 240.
        const batches = groupIntoBatches(files, constraints);
        assert.strictEqual(batches.length, 2);
        assert.strictEqual(batches[0][0].filePath, 'file1.ts');
        assert.strictEqual(batches[1][0].filePath, 'file2.ts');
    });

    test('groupIntoBatches: should throw error if instructions alone exceed budget', () => {
        const files: FileContext[] = [{ filePath: 'f.ts', content: 'c' }];
        const constraints: BatchConstraints = {
            maxTokensPerBatch: 100,
            instructionTokens: 150
        };
        assert.throws(() => groupIntoBatches(files, constraints), /Instruction size/);
    });

    test('groupIntoBatches: should throw error if a single file exceeds budget', () => {
        const files: FileContext[] = [{ filePath: 'huge.ts', content: 'a'.repeat(4000) }]; // ~1000 tokens
        const constraints: BatchConstraints = {
            maxTokensPerBatch: 500,
            instructionTokens: 50
        };
        assert.throws(() => groupIntoBatches(files, constraints), /too large/);
    });

    test('groupIntoBatches: should handle empty file list', () => {
        const batches = groupIntoBatches([], { maxTokensPerBatch: 1000, instructionTokens: 100 });
        assert.strictEqual(batches.length, 0);
    });
});
