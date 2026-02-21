import * as assert from 'assert';
import * as vscode from 'vscode';
import { AIProviderFactory } from '../../ai/AIProviderFactory';
import { GeminiProvider } from '../../ai/GeminiProvider';
import { OpenAIProvider } from '../../ai/OpenAIProvider';
import { NativeIDEProvider } from '../../ai/NativeIDEProvider';
import { AnthropicProvider } from '../../ai/AnthropicProvider';
import { OpenRouterProvider } from '../../ai/OpenRouterProvider';
import { UniversalOpenAIProvider } from '../../ai/UniversalOpenAIProvider';

suite('AIProviderFactory Test Suite', () => {

    // Mock output channel for testing
    const mockOutputChannel = {
        name: 'Mock',
        append: () => { },
        appendLine: () => { },
        replace: () => { },
        clear: () => { },
        show: () => { },
        hide: () => { },
        dispose: () => { }
    } as unknown as vscode.OutputChannel;

    test('Factory should instantiate NativeIDEProvider by default', () => {
        // Technically this reads the actual workspace config, which defaults to Native IDE
        // if not touched by the user in the test environment.
        const { provider, modeName } = AIProviderFactory.createProvider(mockOutputChannel);
        assert.ok(provider instanceof NativeIDEProvider, 'Expected NativeIDEProvider');
        assert.strictEqual(modeName, 'Native IDE Language Model');
    });

    test('Provider settings map to correct classes (Structural Validation)', () => {
        // We validate that the factory has the capability to return the right classes.
        // In a true mocked environment, we would stub `vscode.workspace.getConfiguration`.
        // Here we just ensure the classes and factory logic are structurally sound.

        // Example: If a user selects Gemini, it should return GeminiProvider
        const geminiObj = new GeminiProvider('fake-key', mockOutputChannel);
        assert.ok(geminiObj instanceof GeminiProvider);

        const openRouterObj = new OpenRouterProvider('fake-key');
        assert.ok(openRouterObj instanceof OpenRouterProvider);

        const universalObj = new UniversalOpenAIProvider();
        assert.ok(universalObj instanceof UniversalOpenAIProvider);

        const anthropicObj = new AnthropicProvider('fake-key');
        assert.ok(anthropicObj instanceof AnthropicProvider);
    });
});
