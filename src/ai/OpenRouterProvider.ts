import * as vscode from 'vscode';
import OpenAI from 'openai';
import { IProvider, ProviderResult } from './IProvider';

export class OpenRouterProvider implements IProvider {
    private openai: OpenAI;
    private model: string;

    constructor(providedKey?: string) {
        const config = vscode.workspace.getConfiguration('agenticGatekeeper');
        const defaultKey = config.get<string>('openRouterApiKey');
        const apiKey = providedKey || defaultKey;
        this.model = config.get<string>('openRouterModel') || 'deepseek/deepseek-coder';

        if (!apiKey) {
            vscode.window.showErrorMessage('Agentic Gatekeeper: OpenRouter API Key is missing. Please configure it in settings.');
        }

        // Initialize the OpenAI SDK but point it to OpenRouter's endpoint
        this.openai = new OpenAI({
            baseURL: 'https://openrouter.ai/api/v1',
            apiKey: apiKey || 'MISSING_KEY',
            defaultHeaders: {
                'HTTP-Referer': config.get<string>('openRouterReferer') || 'https://github.com/yourusername/yourproject',
                'X-Title': config.get<string>('openRouterTitle') || 'Agentic Gatekeeper Client',
            }
        });
    }

    public async execute(systemPrompt: string, userPrompt: string): Promise<ProviderResult> {
        try {
            const response = await this.openai.chat.completions.create({
                model: this.model,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt }
                ],
                temperature: 0.1,
            });

            const content = response.choices[0]?.message?.content || null;
            const usage = response.usage ? {
                promptTokens: response.usage.prompt_tokens,
                completionTokens: response.usage.completion_tokens,
                totalTokens: response.usage.total_tokens,
            } : null;

            return { content, usage, model: this.model };

        } catch (error: any) {
            console.error('OpenRouter API Error:', error);
            vscode.window.showErrorMessage(`Agentic Gatekeeper: OpenRouter Error - ${error.message}`);
            return { content: null, usage: null, model: this.model };
        }
    }
}
