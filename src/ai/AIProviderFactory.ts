import * as vscode from 'vscode';
import { IProvider } from './IProvider';
import { GeminiProvider } from './GeminiProvider';
import { OpenAIProvider } from './OpenAIProvider';
import { NativeIDEProvider } from './NativeIDEProvider';
import { AnthropicProvider } from './AnthropicProvider';
import { OpenRouterProvider } from './OpenRouterProvider';
import { UniversalOpenAIProvider } from './UniversalOpenAIProvider';

export class AIProviderFactory {
    /**
     * Determines the appropriate AI provider based on VS Code configuration.
     * Prioritizes Gemini > OpenAI > Native IDE models.
     */
    public static createProvider(outputChannel: vscode.OutputChannel): { provider: IProvider, modeName: string } {
        const config = vscode.workspace.getConfiguration('agenticGatekeeper');
        const selectedProvider = config.get<string>('aiProvider') || 'Native IDE';

        switch (selectedProvider) {
            case 'Gemini':
                return {
                    provider: new GeminiProvider(config.get<string>('geminiApiKey') || '', outputChannel),
                    modeName: 'External Gemini API'
                };
            case 'OpenAI':
                return {
                    provider: new OpenAIProvider(config.get<string>('openaiApiKey')),
                    modeName: 'External OpenAI API'
                };
            case 'Anthropic':
                return {
                    provider: new AnthropicProvider(config.get<string>('anthropicApiKey')),
                    modeName: 'External Anthropic API (Claude)'
                };
            case 'OpenRouter':
                return {
                    provider: new OpenRouterProvider(config.get<string>('openRouterApiKey')),
                    modeName: 'External OpenRouter API'
                };
            case 'Custom (Ollama/Local)':
                return {
                    provider: new UniversalOpenAIProvider(),
                    modeName: 'Custom OpenAI-Compatible API'
                };
            case 'Native IDE':
            default:
                return {
                    provider: new NativeIDEProvider(outputChannel),
                    modeName: 'Native IDE Language Model'
                };
        }
    }
}
