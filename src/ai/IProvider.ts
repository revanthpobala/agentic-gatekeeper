export interface IProvider {
    /**
     * Executes a prompt against the configured AI model.
     * @param systemPrompt The instructions/rules governing the AI
     * @param userPrompt The diff/context to analyze
     */
    execute(systemPrompt: string, userPrompt: string): Promise<string | null>;
}
