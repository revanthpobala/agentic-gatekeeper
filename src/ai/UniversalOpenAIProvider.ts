import * as vscode from 'vscode';
import OpenAI from 'openai';
import { IProvider, ProviderResult } from './IProvider';

export class UniversalOpenAIProvider implements IProvider {
    private openai: OpenAI;
    private model: string;

    constructor() {
        const config = vscode.workspace.getConfiguration('agenticGatekeeper');
        const baseUrl = config.get<string>('customBaseUrl') || 'http://localhost:11434/v1'; // Default to Ollama
        const apiKey = config.get<string>('customApiKey') || 'ollama'; // Local APIs usually ignore this, but SDK requires it
        this.model = config.get<string>('customModel') || 'llama3';

        this.openai = new OpenAI({
            baseURL: baseUrl,
            apiKey: apiKey,
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
            // Local models may or may not return usage data
            const usage = response.usage ? {
                promptTokens: response.usage.prompt_tokens,
                completionTokens: response.usage.completion_tokens,
                totalTokens: response.usage.total_tokens,
            } : null;

            return { content, usage, model: this.model };

        } catch (error: any) {
            console.error('Custom API Error:', error);
            vscode.window.showErrorMessage(`Agentic Gatekeeper: Custom AI Provider Error - ${error.message}`);
            return { content: null, usage: null, model: this.model };
        }
    }
}
