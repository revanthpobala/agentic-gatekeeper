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
    largeFileThreshold?: number; // Determine patch vs rewrite prediction
    maxRewriteFilesPerBatch?: number; // Cap for rewrite mode
}

/**
 * Groups files into batches that fit within the token budget.
 * Accounts for instruction overhead and enforces a strict cutoff.
 */
export interface BatchResult {
    batches: FileContext[][];
    skipped: string[];
}

export function groupIntoBatches(
    files: FileContext[],
    constraints: BatchConstraints
): BatchResult {
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
    const skipped: string[] = [];

    for (const file of files) {
        const fileTokens = estimateTokens(file.content) + estimateTokens(file.filePath) + 50; // 50 for delimiters

        // If a single file + instructions exceeds the budget, it's a fatal error for that file
        if (fileTokens > effectiveBudget) {
            skipped.push(file.filePath);
            continue;
        }

        // Determine if current batch (with new file) would trigger PATCH mode
        const threshold = constraints.largeFileThreshold ?? 0;
        const willBePatchMode = threshold > 0 && (
            (file.lineCount ?? 0) > threshold || currentBatch.some(f => (f.lineCount ?? 0) > threshold)
        );

        // Enforce the rewrite-mode file cap if applicable
        const hitsRewriteCap = !willBePatchMode &&
            constraints.maxRewriteFilesPerBatch &&
            currentBatch.length >= constraints.maxRewriteFilesPerBatch;

        // If adding this file would exceed the batch budget or file cap, move to a new batch
        if ((currentTokens + fileTokens > effectiveBudget && currentBatch.length > 0) || hitsRewriteCap) {
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

    return { batches, skipped };
}
