import * as vscode from 'vscode';
import OpenAI from 'openai';
import { IProvider, ProviderResult } from './IProvider';

export class OpenAIProvider implements IProvider {
    private openai: OpenAI;
    private model: string;

    constructor(providedKey?: string) {
        // Read configuration from VS Code Settings
        const config = vscode.workspace.getConfiguration('agenticGatekeeper');
        const defaultKey = config.get<string>('openaiApiKey');
        const apiKey = providedKey || defaultKey;
        this.model = config.get<string>('openaiModel') || 'gpt-4o';

        if (!apiKey) {
            vscode.window.showErrorMessage('Agentic Gatekeeper: OpenAI API Key is missing. Please configure it in settings.');
        }

        this.openai = new OpenAI({
            apiKey: apiKey || 'MISSING_KEY'
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
            vscode.window.showErrorMessage(`Agentic Gatekeeper: AI Provider Error - ${error.message}`);
            return { content: null, usage: null, model: this.model };
        }
    }
}
