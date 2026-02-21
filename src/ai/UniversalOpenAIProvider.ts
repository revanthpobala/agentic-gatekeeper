import * as vscode from 'vscode';
import OpenAI from 'openai';
import { IProvider } from './IProvider';

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

    public async execute(systemPrompt: string, userPrompt: string): Promise<string | null> {
        try {
            const response = await this.openai.chat.completions.create({
                model: this.model,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt }
                ],
                temperature: 0.1,
            });

            return response.choices[0]?.message?.content || null;

        } catch (error: any) {
            console.error('Custom API Error:', error);
            vscode.window.showErrorMessage(`Agentic Gatekeeper: Custom AI Provider Error - ${error.message}`);
            return null;
        }
    }
}
