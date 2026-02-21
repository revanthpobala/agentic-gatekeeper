import * as vscode from 'vscode';
import { IProvider } from './IProvider';

export class AnthropicProvider implements IProvider {
    private apiKey: string;
    private model: string;

    constructor(providedKey?: string) {
        const config = vscode.workspace.getConfiguration('agenticGatekeeper');
        const defaultKey = config.get<string>('anthropicApiKey');
        this.apiKey = providedKey || defaultKey || '';
        this.model = config.get<string>('anthropicModel') || 'claude-3-5-sonnet-20241022';

        if (!this.apiKey) {
            vscode.window.showErrorMessage('Agentic Gatekeeper: Anthropic API Key is missing. Please configure it in settings.');
        }
    }

    public async execute(systemPrompt: string, userPrompt: string): Promise<string | null> {
        if (!this.apiKey) {return null;}

        try {
            const response = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'x-api-key': this.apiKey,
                    'anthropic-version': '2023-06-01',
                    'content-type': 'application/json'
                },
                body: JSON.stringify({
                    model: this.model,
                    max_tokens: 4096,
                    temperature: 0.1, // Low temperature for deterministic output
                    system: systemPrompt,
                    messages: [
                        { role: 'user', content: userPrompt }
                    ]
                })
            });

            if (!response.ok) {
                const errorData = await response.json() as any;
                throw new Error(`Anthropic API Error: ${response.status} ${response.statusText} - ${errorData?.error?.message || 'Unknown Error'}`);
            }

            const data = await response.json() as any;

            // Extract text from the first content block
            if (data && data.content && data.content.length > 0) {
                return data.content[0].text || null;
            }
            return null;

        } catch (error: any) {
            console.error('Anthropic API request failed:', error);
            vscode.window.showErrorMessage(`Agentic Gatekeeper: Anthropic Provider Error - ${error.message}`);
            return null;
        }
    }
}
