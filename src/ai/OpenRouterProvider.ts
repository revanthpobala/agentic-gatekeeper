import * as vscode from 'vscode';
import OpenAI from 'openai';
import { IProvider, ProviderResult } from './IProvider';

export class OpenRouterProvider implements IProvider {
    private apiKey: string;
    private model: string;
    private referer: string;
    private title: string;

    constructor(apiKey?: string) {
        const config = vscode.workspace.getConfiguration('agenticGatekeeper');
        this.apiKey = apiKey || '';
        this.model = config.get<string>('openRouter.model') || 'deepseek/deepseek-coder';
        this.referer = config.get<string>('openRouterReferer') || 'https://github.com/yourusername/yourproject';
        this.title = config.get<string>('openRouterTitle') || 'Agentic Gatekeeper Client';
    }

    public async execute(systemPrompt: string, userPrompt: string): Promise<ProviderResult> {
        if (!this.apiKey || this.apiKey.trim() === '') {
            vscode.window.showErrorMessage('Agentic Gatekeeper: OpenRouter API Key is missing. Please configure it in settings.');
            return { content: null, usage: null, model: this.model };
        }

        const openai = new OpenAI({
            baseURL: 'https://openrouter.ai/api/v1',
            apiKey: this.apiKey,
            defaultHeaders: {
                'HTTP-Referer': this.referer,
                'X-Title': this.title,
            }
        });

        try {
            const response = await openai.chat.completions.create({
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
