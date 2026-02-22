import * as vscode from 'vscode';
import OpenAI from 'openai';
import { IProvider, ProviderResult } from './IProvider';

export class GeminiProvider implements IProvider {
    private client: OpenAI;
    private model: string;
    private outputChannel: vscode.OutputChannel | undefined;

    constructor(apiKey: string, outputChannel?: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
        const config = vscode.workspace.getConfiguration('agenticGatekeeper');
        this.model = config.get<string>('geminiModel') || 'gemini-2.0-flash';

        // Gemini exposes an OpenAI-compatible endpoint — reuse the openai SDK
        this.client = new OpenAI({
            apiKey: apiKey,
            baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/'
        });
    }

    private log(msg: string) {
        this.outputChannel?.appendLine(`[Gemini] ${msg}`);
    }

    public async execute(systemPrompt: string, userPrompt: string): Promise<ProviderResult> {
        try {
            this.log(`Sending request to Gemini (model: ${this.model})...`);
            const response = await this.client.chat.completions.create({
                model: this.model,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt }
                ],
                temperature: 0.1,
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
            vscode.window.showErrorMessage(`Agentic Gatekeeper: Gemini Error - ${errMsg}`);
            return { content: null, usage: null, model: this.model };
        }
    }
}
