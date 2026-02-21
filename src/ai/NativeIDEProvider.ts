import * as vscode from 'vscode';
import { IProvider } from './IProvider';

export class NativeIDEProvider implements IProvider {
    private outputChannel: vscode.OutputChannel | undefined;

    constructor(outputChannel?: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
    }

    private log(msg: string) {
        this.outputChannel?.appendLine(`[NativeLM] ${msg}`);
    }

    public async execute(systemPrompt: string, userPrompt: string): Promise<string | null> {
        try {
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

            const chatModel = models[0];
            this.log(`Using model: ${chatModel.id}`);

            const messages = [
                vscode.LanguageModelChatMessage.User(`System Instruction:\n${systemPrompt}\n\nUser Request:\n${userPrompt}`)
            ];

            this.log('Sending request to language model...');
            const chatResponse = await chatModel.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);

            let fullResponse = '';
            for await (const chunk of chatResponse.text) {
                fullResponse += chunk;
            }

            this.log(`Response received. Length: ${fullResponse.length} chars`);

            if (fullResponse.length === 0) {
                this.log('WARNING: Model returned an empty string response.');
            }

            return fullResponse || null;

        } catch (error: any) {
            const errMsg = error?.message || String(error);
            this.log(`ERROR: ${errMsg}`);

            // Check for consent-related errors
            if (errMsg.includes('consent') || errMsg.includes('permission') || errMsg.includes('access')) {
                this.log('This looks like a consent/permission issue. The user may need to approve LM access for this extension.');
            }

            vscode.window.showErrorMessage(`Agentic Gatekeeper: Native AI Error - ${errMsg}`);
            return null;
        }
    }
}
