import * as vscode from 'vscode';
import OpenAI from 'openai';
import { IProvider, ProviderResult } from './IProvider';

export class OpenAIProvider implements IProvider {
    private apiKey: string;
    private model: string;

    constructor(apiKey?: string) {
        const config = vscode.workspace.getConfiguration('agenticGatekeeper');
        this.apiKey = apiKey || '';
        this.model = config.get<string>('openai.model') || 'gpt-4o';
    }

    public async execute(systemPrompt: string, userPrompt: string): Promise<ProviderResult> {
        if (!this.apiKey || this.apiKey.trim() === '') {
            vscode.window.showErrorMessage('Agentic Gatekeeper: OpenAI API Key is missing. Please configure it in settings.');
            return { content: null, usage: null, model: this.model };
        }

        const openai = new OpenAI({ apiKey: this.apiKey });

        try {
            const response = await openai.chat.completions.create({
                model: this.model,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt }
                ],
                temperature: 0.1, // Low temperature for deterministic rule application
            });

            const content = response.choices[0]?.message?.content || null;
            const usage = response.usage ? {
                promptTokens: response.usage.prompt_tokens,
                completionTokens: response.usage.completion_tokens,
                totalTokens: response.usage.total_tokens,
            } : null;

            return { content, usage, model: this.model };

        } catch (error: any) {
            console.error('OpenAI API Error:', error);
            throw error;
        }
    }
}
