import * as vscode from 'vscode';
import OpenAI from 'openai';
import { IProvider, ProviderResult } from './IProvider';

/**
 * Strips trailing path segments that users commonly paste by mistake.
 * The OpenAI SDK automatically appends /chat/completions, so if the user
 * sets the base URL to "http://localhost:4141/v1/chat/completions", we'd
 * end up hitting "/v1/chat/completions/chat/completions" — a 404.
 */
function sanitizeBaseUrl(url: string): string {
    let sanitized = url.trim().replace(/\/+$/, ''); // strip trailing slashes
    // Strip /chat/completions if user pasted the full endpoint
    if (sanitized.endsWith('/chat/completions')) {
        sanitized = sanitized.replace(/\/chat\/completions$/, '');
    }
    // Strip /completions too (some users paste just that)
    if (sanitized.endsWith('/completions')) {
        sanitized = sanitized.replace(/\/completions$/, '');
    }
    return sanitized;
}

export class UniversalOpenAIProvider implements IProvider {
    private openai: OpenAI;
    private model: string;

    constructor() {
        const config = vscode.workspace.getConfiguration('agenticGatekeeper');
        const rawBaseUrl = config.get<string>('custom.baseUrl') || 'http://localhost:11434/v1';
        const baseUrl = sanitizeBaseUrl(rawBaseUrl);
        const apiKey = config.get<string>('custom.apiKey') || 'ollama';
        this.model = config.get<string>('custom.model') || 'llama3';

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
