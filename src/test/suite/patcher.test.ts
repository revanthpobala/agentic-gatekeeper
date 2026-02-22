import * as assert from 'assert';
import { WorkspacePatcher } from '../../applier/WorkspacePatcher';

suite('WorkspacePatcher Test Suite', () => {

  // We only test parsing, so the root path doesn't matter
  const patcher = new WorkspacePatcher('/fake/root');

  test('parseAIResponse extracts clean JSON array', () => {
    const rawJson = `
[
  {
    "filePath": "src/test.ts",
    "newContent": "console.log('clean');"
  }
]
`;
    const result = patcher.parseAIResponse(rawJson);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].filePath, "src/test.ts");
  });

  test('parseAIResponse extracts JSON hidden inside markdown code blocks', () => {
    const messyResponse = `
Here is the refactored code based on your rules:

\`\`\`json
[
  {
    "filePath": "src/utils.ts",
    "newContent": "export const foo = 'bar';"
  }
]
\`\`\`

I hope this helps!
`;
    const result = patcher.parseAIResponse(messyResponse);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].filePath, "src/utils.ts");
  });

  test('parseAIResponse returns empty array for conversational hallucination without JSON', () => {
    const hallucination = "I have reviewed your code. Everything looks great, but you should consider adding more comments.";
    const result = patcher.parseAIResponse(hallucination);
    assert.strictEqual(result.length, 0); // Should not crash
  });

  test('parseAIResponse gracefully handles broken JSON syntax', () => {
    const brokenJson = `
[
  {
    "filePath": "src/broken.ts",
    "newContent": "missing closing quote
  }
]
`;
    const result = patcher.parseAIResponse(brokenJson);
    assert.strictEqual(result.length, 0); // Try/catch should swallow Error and return []
  });

  test('parseAIResponse extracts JSON if not tricked by preceding loose characters', () => {
    const trickyResponse = `
I found issues in src/file1.ts and src/file2.ts. Here is the fix:

[
  {
    "filePath": "src/file1.ts",
    "newContent": "let a = 1;"
  }
]
`;
    const result = patcher.parseAIResponse(trickyResponse);
    // The implementation uses simple indexOf('['), so we must ensure no preceding brackets exist
    // or that the first set of brackets is the JSON array.
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].newContent, "let a = 1;");
  });
});
