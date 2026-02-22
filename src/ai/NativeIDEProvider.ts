import * as vscode from 'vscode';
import { IProvider, ProviderResult } from './IProvider';

// Models known to be listed but not actually supported
const BLOCKED_MODELS = ['gpt-5-mini', 'oswe-vscode-prime', 'copilot-fast'];

// Preference order: try stable, well-known models first
const PREFERRED_MODEL_ORDER = ['gpt-4.1', 'gpt-4o', 'claude-haiku-4.5', 'gpt-4o-mini', 'auto'];

export class NativeIDEProvider implements IProvider {
    private outputChannel: vscode.OutputChannel | undefined;
    private cachedModelPromise: Promise<vscode.LanguageModelChat | null> | null = null;

    constructor(outputChannel?: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
    }

    private log(msg: string) {
        this.outputChannel?.appendLine(`[NativeLM] ${msg}`);
    }

    private async getModelInfo(): Promise<vscode.LanguageModelChat | null> {
        if (!this.cachedModelPromise) {
            this.cachedModelPromise = (async () => {
                this.log('Querying available language models...');
                const models = await vscode.lm.selectChatModels({});

                if (models.length === 0) {
                    const errMsg = 'No built-in language models found. Ensure Copilot, Gemini, or another LM provider is enabled.';
                    this.log(`ERROR: ${errMsg}`);
                    vscode.window.showErrorMessage(`Agentic Gatekeeper: ${errMsg}`);
                    return null;
                }

                this.log(`Found ${models.length} model(s):`);
                for (const m of models) {
                    this.log(`  - ${m.id} (family: ${m.family}, vendor: ${m.vendor})`);
                }

                const config = vscode.workspace.getConfiguration('agenticGatekeeper');
                const selector = config.get<string>('native.modelSelector')?.trim().toLowerCase();

                // 1. If user explicitly set a preference, honor it
                if (selector) {
                    const targetModel = models.find(m =>
                        m.id.toLowerCase().includes(selector) ||
                        m.family.toLowerCase().includes(selector)
                    );

                    if (targetModel) {
                        this.log(`User preferred model '${selector}' matched with: ${targetModel.id}`);
                        return targetModel;
                    } else {
                        this.log(`WARNING: User preferred model '${selector}' was not found. Falling back to auto-select.`);
                    }
                }

                // 2. Filter out known-broken models
                const usableModels = models.filter(m =>
                    !BLOCKED_MODELS.some(blocked => m.id.toLowerCase().includes(blocked))
                );

                if (usableModels.length === 0) {
                    this.log('WARNING: All available models are blocked. Trying models[0] as last resort.');
                    return models[0];
                }

                // 3. Pick the best model by preference order
                for (const preferred of PREFERRED_MODEL_ORDER) {
                    const match = usableModels.find(m =>
                        m.id.toLowerCase().includes(preferred) ||
                        m.family.toLowerCase().includes(preferred)
                    );
                    if (match) {
                        this.log(`Auto-selected model: ${match.id} (matched preference '${preferred}')`);
                        return match;
                    }
                }

                // 4. Fallback: first usable model
                this.log(`Using first usable model: ${usableModels[0].id}`);
                return usableModels[0];
            })();
        }
        return this.cachedModelPromise;
    }

    public async execute(systemPrompt: string, userPrompt: string): Promise<ProviderResult> {
        try {
            const chatModel = await this.getModelInfo();
            if (!chatModel) { return { content: null, usage: null, model: 'native-ide' }; }

            const messages = [
                vscode.LanguageModelChatMessage.User(`System Instruction:\n${systemPrompt}\n\nUser Request:\n${userPrompt}`)
            ];

            const chatResponse = await chatModel.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);

            let fullResponse = '';
            for await (const chunk of chatResponse.text) {
                fullResponse += chunk;
            }

            this.log(`Response received. Length: ${fullResponse.length} chars`);

            if (fullResponse.length === 0) {
                this.log('WARNING: Model returned an empty string response.');
            }

            // Native IDE API does not expose token usage
            return { content: fullResponse || null, usage: null, model: chatModel.id };

        } catch (error: any) {
            const errMsg = error?.message || String(error);
            this.log(`ERROR: ${errMsg}`);

            // If the model is not supported, clear the cache so next call retries with a different model
            if (errMsg.includes('model_not_supported') || errMsg.includes('not supported')) {
                this.log('Model not supported. Clearing cache to retry with next available model.');
                this.cachedModelPromise = null;
            }

            // Check for consent-related errors
            if (errMsg.includes('consent') || errMsg.includes('permission') || errMsg.includes('access')) {
                this.log('This looks like a consent/permission issue. The user may need to approve LM access for this extension.');
            }

            vscode.window.showErrorMessage(`Agentic Gatekeeper: Native AI Error - ${errMsg}`);
            return { content: null, usage: null, model: 'native-ide' };
        }
    }
}
