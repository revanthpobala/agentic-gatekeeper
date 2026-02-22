import * as vscode from 'vscode';
import { IProvider, ProviderResult } from './IProvider';

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

                let chatModel = models[0]; // fallback default

                if (selector) {
                    const targetModel = models.find(m =>
                        m.id.toLowerCase().includes(selector) ||
                        m.family.toLowerCase().includes(selector)
                    );

                    if (targetModel) {
                        chatModel = targetModel;
                        this.log(`User preferred model '${selector}' matched with: ${chatModel.id}`);
                    } else {
                        this.log(`WARNING: User preferred model '${selector}' was not found. Falling back to default.`);
                    }
                }

                this.log(`Using model: ${chatModel.id}`);
                return chatModel;
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

            // Check for consent-related errors
            if (errMsg.includes('consent') || errMsg.includes('permission') || errMsg.includes('access')) {
                this.log('This looks like a consent/permission issue. The user may need to approve LM access for this extension.');
            }

            vscode.window.showErrorMessage(`Agentic Gatekeeper: Native AI Error - ${errMsg}`);
            return { content: null, usage: null, model: 'native-ide' };
        }
    }
}
