import * as assert from 'assert';
import { AIAgent } from '../../ai/AIAgent';
import { IProvider } from '../../ai/IProvider';

suite('AIAgent Integration Test Suite', () => {

    test('buildSystemPrompt encapsulates file paths correctly', () => {
        const agent = new AIAgent();

        // Expose private method for testing purposes via any cast
        const buildSystemPrompt = (agent as any).buildSystemPrompt.bind(agent);

        const mockInstructions = "Rule 1: No console.log";
        const prompt = buildSystemPrompt(mockInstructions);

        // Ensure the prompt enforces the SINGLE FILE rule since our sequential update
        assert.ok(prompt.includes('SINGLE STAGED FILE'), 'System prompt should define it is analyzing a single file context');
        assert.ok(prompt.includes(mockInstructions), 'System prompt should inject the rules');
        assert.ok(prompt.includes('JSON SCHEMA'), 'System prompt should define the exact JSON return structure');
    });

    test('analyze method handles compliant responses', async () => {
        const agent = new AIAgent();

        // Create a fake AI Provider that always says COMPLIANT
        const mockProvider: IProvider = {
            execute: async (systemPrompt: string, userPrompt: string) => {
                return "   COMPLIANT   "; // Should handle whitespace
            }
        };

        const mockFile = [{ filePath: 'sample-math.ts', content: 'export function add(a,b){return a+b;}' }];
        const result = await agent.analyze("Rules", mockFile, mockProvider);

        assert.strictEqual(result?.trim(), "COMPLIANT");
    });

    test('analyze method handles mutation payloads', async () => {
        const agent = new AIAgent();

        // Create a fake AI Provider that returns a JSON mutation block
        const expectedMutation = "[\n  {\n    \"filePath\": \"sample-math.ts\",\n    \"newContent\": \"// Fixed code\"\n  }\n]";
        const mockProvider: IProvider = {
            execute: async (systemPrompt: string, userPrompt: string) => {
                return `Here is your code: \n\n\`\`\`json\n${expectedMutation}\n\`\`\``;
            }
        };

        const mockFile = [{ filePath: 'sample-math.ts', content: 'export function calculateTotal(price, tax){return price * tax;}' }];
        const result = await agent.analyze("Require JSDoc", mockFile, mockProvider);

        // Extracting just ensures that the agent successfully passed data from the provider
        assert.ok(result?.includes(expectedMutation));
    });
});
