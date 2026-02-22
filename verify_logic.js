const assert = require('assert');
const { groupIntoBatches, estimateTokens } = require('./out/engine/BatchProcessor');

console.log('--- Starting Gatekeeper Logic Verification ---');

function runTest(name, fn) {
    try {
        fn();
        console.log(`[PASS] ${name}`);
    } catch (err) {
        console.error(`[FAIL] ${name}`);
        console.error(err);
        process.exit(1);
    }
}

runTest('Token Estimation', () => {
    assert.strictEqual(estimateTokens('abcd'), 1);
    assert.strictEqual(estimateTokens('abcdefgh'), 2);
});

runTest('Basic Batching', () => {
    const files = [
        { filePath: 'f1.ts', content: 'content1' },
        { filePath: 'f2.ts', content: 'content2' }
    ];
    // Use safetyBuffer 0 for small test budgets
    const batches = groupIntoBatches(files, { maxTokensPerBatch: 1000, instructionTokens: 100, safetyBuffer: 0 });
    assert.strictEqual(batches.length, 1);
    assert.strictEqual(batches[0].length, 2);
});

runTest('Strict Budget Split', () => {
    const files = [
        { filePath: 'f1.ts', content: 'a'.repeat(400) }, // ~100 tokens
        { filePath: 'f2.ts', content: 'b'.repeat(400) }  // ~100 tokens
    ];
    // file size = 100 + path(2) + delim(50) = 152
    // budget = 400 - instruction(100) - buffer(100) = 200
    // 152 + 152 > 200 => should split
    const batches = groupIntoBatches(files, {
        maxTokensPerBatch: 400,
        instructionTokens: 100,
        safetyBuffer: 100
    });
    assert.strictEqual(batches.length, 2);
});

runTest('Instruction Overflow (Fatal)', () => {
    const files = [{ filePath: 'f.ts', content: 'c' }];
    assert.throws(() => {
        groupIntoBatches(files, { maxTokensPerBatch: 100, instructionTokens: 150 });
    }, /Instruction size/);
});

runTest('Single File Overflow (Fatal)', () => {
    const files = [{ filePath: 'huge.ts', content: 'a'.repeat(4000) }]; // ~1000 tokens
    assert.throws(() => {
        groupIntoBatches(files, { maxTokensPerBatch: 500, instructionTokens: 50, safetyBuffer: 0 });
    }, /too large/);
});

console.log('--- Verification Complete: All logic gates passed ---');
