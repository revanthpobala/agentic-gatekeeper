import * as vscode from 'vscode';
import OpenAI from 'openai';
import { IProvider } from './IProvider';

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

    public async execute(systemPrompt: string, userPrompt: string): Promise<string | null> {
        try {
            const response = await this.openai.chat.completions.create({
                model: this.model,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt }
                ],
                temperature: 0.1, // Low temperature for deterministic rule application
            });

            return response.choices[0]?.message?.content || null;

        } catch (error: any) {
            console.error('OpenAI API Error:', error);
            vscode.window.showErrorMessage(`Agentic Gatekeeper: AI Provider Error - ${error.message}`);
            return null;
        }
    }
}
