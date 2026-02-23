import * as vscode from 'vscode';
import OpenAI from 'openai';
import { IProvider, ProviderResult } from './IProvider';

export class GeminiProvider implements IProvider {
    private apiKey: string;
    private model: string;
    private outputChannel: vscode.OutputChannel | undefined;

    constructor(apiKey?: string, outputChannel?: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
        const config = vscode.workspace.getConfiguration('agenticGatekeeper');
        this.apiKey = apiKey || '';
        this.model = config.get<string>('gemini.model') || 'gemini-2.0-flash';
    }

    private log(msg: string) {
        this.outputChannel?.appendLine(`[Gemini] ${msg}`);
    }

    public async execute(systemPrompt: string, userPrompt: string): Promise<ProviderResult> {
        if (!this.apiKey || this.apiKey.trim() === '') {
            vscode.window.showErrorMessage('Agentic Gatekeeper: Gemini API Key is missing. Please configure it in settings.');
            return { content: null, usage: null, model: this.model };
        }

        const client = new OpenAI({
            apiKey: this.apiKey,
            baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/'
        });

        try {
            this.log(`Sending request to Gemini (model: ${this.model})...`);
            const response = await client.chat.completions.create({
                model: this.model,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt }
                ],
                temperature: 0.1
            });

            const content = response.choices[0]?.message?.content || null;
            this.log(`Response received. Length: ${content?.length ?? 0} chars`);

            const usage = response.usage ? {
                promptTokens: response.usage.prompt_tokens,
                completionTokens: response.usage.completion_tokens,
                totalTokens: response.usage.total_tokens,
            } : null;

            return { content, usage, model: this.model };

        } catch (error: any) {
            const errMsg = error?.message || String(error);
            this.log(`ERROR: ${errMsg}`);
            vscode.window.showErrorMessage(`Agentic Gatekeeper: Gemini Provider Error - ${errMsg}`);
            return { content: null, usage: null, model: this.model };
        }
    }
}
