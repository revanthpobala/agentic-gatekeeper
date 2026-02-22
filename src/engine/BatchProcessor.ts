import { FileContext } from '../ai/AIAgent';

/**
 * Standard token estimation (4 characters = 1 token).
 */
export function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

export interface BatchConstraints {
    maxTokensPerBatch: number;
    instructionTokens: number;
    safetyBuffer?: number; // Default 2000
}

/**
 * Groups files into batches that fit within the token budget.
 * Accounts for instruction overhead and enforces a strict cutoff.
 */
export function groupIntoBatches(
    files: FileContext[],
    constraints: BatchConstraints
): FileContext[][] {
    const { maxTokensPerBatch, instructionTokens } = constraints;
    const safetyBuffer = constraints.safetyBuffer ?? 2000;

    const batches: FileContext[][] = [];
    let currentBatch: FileContext[] = [];

    // Total budget per batch must include instructions and headroom for completion
    const effectiveBudget = maxTokensPerBatch - instructionTokens - safetyBuffer;

    // If the instructions ALONE exceed the maxTokensPerBatch, we can't even send one batch.
    if (effectiveBudget <= 0) {
        throw new Error(`Instruction size (${instructionTokens} tokens) exceeds or too close to total batch limit (${maxTokensPerBatch} tokens). Reduce instructions or increase token budget.`);
    }

    let currentTokens = 0;

    for (const file of files) {
        const fileTokens = estimateTokens(file.content) + estimateTokens(file.filePath) + 50; // 50 for delimiters

        // If a single file + instructions exceeds the budget, it's a fatal error for that file
        if (fileTokens > effectiveBudget) {
            // We'll throw an error for now to be strict. 
            // In the future we might want to skip the file but continue other batches.
            throw new Error(`File '${file.filePath}' is too large (${fileTokens} tokens). With instructions, it exceeds the batch limit of ${maxTokensPerBatch} tokens.`);
        }

        // If adding this file would exceed the batch budget, move to a new batch
        if (currentTokens + fileTokens > effectiveBudget && currentBatch.length > 0) {
            batches.push(currentBatch);
            currentBatch = [file];
            currentTokens = fileTokens;
        } else {
            currentBatch.push(file);
            currentTokens += fileTokens;
        }
    }

    if (currentBatch.length > 0) {
        batches.push(currentBatch);
    }

    return batches;
}
