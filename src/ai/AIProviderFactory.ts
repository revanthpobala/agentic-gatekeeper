import * as vscode from 'vscode';
import { IProvider } from './IProvider';
import { GeminiProvider } from './GeminiProvider';
import { OpenAIProvider } from './OpenAIProvider';
import { NativeIDEProvider } from './NativeIDEProvider';
import { AnthropicProvider } from './AnthropicProvider';
import { OpenRouterProvider } from './OpenRouterProvider';
import { UniversalOpenAIProvider } from './UniversalOpenAIProvider';

// Default values that indicate the user hasn't intentionally configured the Custom provider
const DEFAULT_CUSTOM_BASE_URL = 'http://localhost:11434/v1';

export class AIProviderFactory {
    /**
     * Determines the appropriate AI provider based on VS Code configuration.
     * Implements intelligent auto-detection: if the user configured a custom
     * base URL or API key, auto-upgrade from Native IDE to the appropriate provider.
     */
    public static createProvider(outputChannel: vscode.OutputChannel): { provider: IProvider, modeName: string } {
        const config = vscode.workspace.getConfiguration('agenticGatekeeper');
        let selectedProvider = config.get<string>('aiProvider') || 'Native IDE';

        // Intelligent Defaults: If the user left the dropdown on "Native IDE"
        // but they clearly configured a provider, auto-upgrade them.
        if (selectedProvider === 'Native IDE') {
            const keys = {
                custom: config.get<string>('custom.apiKey'),
                openai: config.get<string>('openai.apiKey'),
                anthropic: config.get<string>('anthropic.apiKey'),
                gemini: config.get<string>('gemini.apiKey'),
                openRouter: config.get<string>('openRouter.apiKey')
            };

            const customBaseUrl = config.get<string>('custom.baseUrl')?.trim() || '';

            // Auto-detect Custom provider: trigger if the user changed the base URL
            // from the default OR set a non-default API key
            const hasCustomBaseUrl = customBaseUrl !== '' && customBaseUrl !== DEFAULT_CUSTOM_BASE_URL;
            const hasCustomApiKey = keys.custom && keys.custom.trim() !== '' && keys.custom !== 'lm-studio' && keys.custom !== 'ollama';

            if (hasCustomBaseUrl || hasCustomApiKey) {
                selectedProvider = 'Custom (Ollama/Local)';
                outputChannel.appendLine(`[System] Auto-upgraded provider to Custom API (detected base URL: ${customBaseUrl || DEFAULT_CUSTOM_BASE_URL}).`);
            } else if (keys.openai && keys.openai.trim() !== '') {
                selectedProvider = 'OpenAI';
                outputChannel.appendLine("[System] Auto-upgraded provider to OpenAI based on configured key.");
            } else if (keys.anthropic && keys.anthropic.trim() !== '') {
                selectedProvider = 'Anthropic';
                outputChannel.appendLine("[System] Auto-upgraded provider to Anthropic based on configured key.");
            } else if (keys.gemini && keys.gemini.trim() !== '') {
                selectedProvider = 'Gemini';
                outputChannel.appendLine("[System] Auto-upgraded provider to Gemini based on configured key.");
            } else if (keys.openRouter && keys.openRouter.trim() !== '') {
                selectedProvider = 'OpenRouter';
                outputChannel.appendLine("[System] Auto-upgraded provider to OpenRouter based on configured key.");
            }
        }

        switch (selectedProvider) {
            case 'Gemini':
                return {
                    provider: new GeminiProvider(config.get<string>('gemini.apiKey') || '', outputChannel),
                    modeName: 'External Gemini API'
                };
            case 'OpenAI':
                return {
                    provider: new OpenAIProvider(config.get<string>('openai.apiKey')),
                    modeName: 'External OpenAI API'
                };
            case 'Anthropic':
                return {
                    provider: new AnthropicProvider(config.get<string>('anthropic.apiKey')),
                    modeName: 'External Anthropic API (Claude)'
                };
            case 'OpenRouter':
                return {
                    provider: new OpenRouterProvider(config.get<string>('openRouter.apiKey')),
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
