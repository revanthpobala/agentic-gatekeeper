import * as vscode from 'vscode';
import * as path from 'path';

export interface FileChange {
    filePath: string;
    reason?: string;
    newContent: string;
}

export interface PatchOperation {
    search: string;
    replace: string;
}

export interface FilePatch {
    filePath: string;
    reason?: string;
    patches: PatchOperation[];
}

export class WorkspacePatcher {
    private workspaceRoot: string;
    private outputChannel?: vscode.OutputChannel;

    constructor(workspaceRoot: string, outputChannel?: vscode.OutputChannel) {
        this.workspaceRoot = workspaceRoot;
        this.outputChannel = outputChannel;
    }

    public parseAIResponse(response: string): FileChange[] {
        const raw = response.trim();
        const attempt1 = this.tryParseFileChanges(raw);
        if (attempt1) { return this.filterChanges(attempt1); }

        const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
        if (fenceMatch) {
            const attempt2 = this.tryParseFileChanges(fenceMatch[1].trim());
            if (attempt2) {
                return this.filterChanges(attempt2);
            }
        }

        const firstBracket = raw.indexOf('[');
        const lastBracket = raw.lastIndexOf(']');

        if (firstBracket !== -1 && lastBracket > firstBracket) {
            const attempt3 = this.tryParseFileChanges(raw.slice(firstBracket, lastBracket + 1));
            if (attempt3) { return this.filterChanges(attempt3); }
        }

        this.logChannel(`No valid JSON array found in response: ${raw.slice(0, 50)}...`);
        return [];
    }

    public parseAIPatchResponse(response: string): FilePatch[] {
        const raw = response.trim();

        // Check for explicit empty array (model says "no patches needed")
        const stripped = raw.replace(/```(?:json)?\s*\n?|\n?\s*```/g, '').trim();
        if (stripped === '[]') {
            this.logChannel(`AI returned empty patch array [] - treating as "no patches found" (will NOT be cached).`);
            return [];
        }

        const attempt1 = this.tryParseFilePatches(raw);
        if (attempt1) { return attempt1; } // Filtering happens in engine or later

        const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
        if (fenceMatch) {
            const attempt2 = this.tryParseFilePatches(fenceMatch[1].trim());
            if (attempt2) { return attempt2; }
        }

        const firstBracket = raw.indexOf('[');
        const lastBracket = raw.lastIndexOf(']');

        if (firstBracket !== -1 && lastBracket > firstBracket) {
            const attempt3 = this.tryParseFilePatches(raw.slice(firstBracket, lastBracket + 1));
            if (attempt3) { return attempt3; }
        }

        this.logChannel(`No valid JSON patch array found in response: ${raw.slice(0, 50)}...`);
        return [];
    }

    private tryParseFileChanges(text: string): FileChange[] | null {
        try {
            // Basic sanitization: strip trailing commas in arrays/objects
            const sanitized = text
                .replace(/,\s*\]/g, ']')
                .replace(/,\s*\}/g, '}');

            const parsed = JSON.parse(sanitized);
            if (!Array.isArray(parsed)) { return null; }
            // Validate shape of each element
            const valid = parsed.filter(
                (item): item is FileChange =>
                    typeof item === 'object' &&
                    item !== null &&
                    typeof item.filePath === 'string' &&
                    item.filePath.length > 0 &&
                    (item.reason === undefined || typeof item.reason === 'string') &&
                    typeof item.newContent === 'string'
            );
            return valid.length > 0 ? valid : null;
        } catch {
            return null;
        }
    }

    private tryParseFilePatches(text: string): FilePatch[] | null {
        try {
            const sanitized = text
                .replace(/,\s*\]/g, ']')
                .replace(/,\s*\}/g, '}');

            const parsed = JSON.parse(sanitized);
            if (!Array.isArray(parsed)) { return null; }

            const valid = parsed.filter(
                (item): item is FilePatch =>
                    typeof item === 'object' &&
                    item !== null &&
                    typeof item.filePath === 'string' &&
                    item.filePath.length > 0 &&
                    Array.isArray(item.patches) &&
                    item.patches.every((p: any) =>
                        typeof p === 'object' && p !== null &&
                        typeof p.search === 'string' &&
                        typeof p.replace === 'string'
                    )
            );
            return valid.length > 0 ? valid : null;
        } catch {
            return null;
        }
    }

    private filterChanges(changes: FileChange[]): FileChange[] {
        const junkPatterns = [
            'full_rewritten_file_content_with_all_fixes',
            '... (actual rewritten file content) ...',
            '// ... existing code ...',
            '// existing code here',
            '// same as before',
            '// same as original',
            '/* ... */',
            'same as above',
            'omitted for brevity',
            'truncated for brevity'
        ];

        return changes.filter(change => {
            const content = change.newContent.trim();
            const lowerContent = content.toLowerCase();

            // Reject single-word/short status responses using accurate regex
            if (/^(ok|fixed|compliant|pass|done|no\s+violations?)$/i.test(content)) {
                this.logChannel(`REJECTED ${change.filePath} - content is a status word.`);
                vscode.window.showWarningMessage(
                    `Agentic Gatekeeper: AI returned a status word ("${content}") as file content for ${change.filePath}. Skipping.`
                );
                return false;
            }

            const detectedJunk = junkPatterns.find(p => lowerContent.includes(p));
            if (detectedJunk) {
                this.logChannel(`REJECTED ${change.filePath} - contains placeholder: "${detectedJunk}"`);
                vscode.window.showWarningMessage(
                    `Agentic Gatekeeper: AI returned a placeholder for ${change.filePath}. Skipping to protect your code.`
                );
                return false;
            }

            return true;
        });
    }

    public filterPatches(patches: FilePatch[]): FilePatch[] {
        const junkPatterns = [
            '// ... existing code ...',
            '// existing code here',
            '// same as before',
            '/* ... */',
            'omitted for brevity',
            'truncated for brevity'
        ];

        return patches.filter(filePatch => {
            const validPatches = filePatch.patches.filter(patch => {
                if (!patch.search || patch.search.trim().length === 0) {
                    this.logChannel(`REJECTED patch in ${filePatch.filePath} - empty search string.`);
                    return false;
                }

                const lowerReplace = patch.replace.toLowerCase();
                if (/^(ok|fixed|compliant|pass|done|no\s+violations?)$/i.test(patch.replace.trim())) {
                    this.logChannel(`REJECTED patch in ${filePatch.filePath} - substitution is a status word.`);
                    return false;
                }

                const detectedJunk = junkPatterns.find(p => lowerReplace.includes(p));
                if (detectedJunk) {
                    this.logChannel(`REJECTED patch in ${filePatch.filePath} - replace contains placeholder: "${detectedJunk}"`);
                    return false;
                }

                if (patch.search === patch.replace) {
                    this.logChannel(`REJECTED patch in ${filePatch.filePath} - search and replace are identical (no-op).`);
                    return false;
                }

                return true;
            });

            filePatch.patches = validPatches;
            return validPatches.length > 0;
        });
    }

    private normalizeText(text: string): { normalized: string, indexMap: number[] } {
        const normalizedChars: string[] = [];
        const indexMap: number[] = [];

        // State for tracking sequences of whitespace
        let inWhitespace = false;

        for (let i = 0; i < text.length; i++) {
            const char = text[i];

            if (/\s/.test(char)) {
                if (!inWhitespace) {
                    normalizedChars.push(' ');
                    indexMap.push(i);
                    inWhitespace = true;
                }
                // If we're already in whitespace, we skip adding ' ' again
                // but we map this original string index to the last written char
            } else {
                normalizedChars.push(char);
                indexMap.push(i);
                inWhitespace = false;
            }
        }

        // Add one final map entry for the end of the string
        indexMap.push(text.length);

        return {
            normalized: normalizedChars.join(''),
            indexMap
        };
    }

    private findNormalizedMatch(documentText: string, searchRaw: string): { found: boolean, isAmbiguous: boolean, startOriginal?: number, endOriginal?: number } {
        const docObj = this.normalizeText(documentText);
        // We only trim the search string before normalization to avoid edge boundary mismatch
        const searchObj = this.normalizeText(searchRaw.trim());

        const docNorm = docObj.normalized;
        const searchNorm = searchObj.normalized;

        if (searchNorm.length === 0) return { found: false, isAmbiguous: false };

        let firstIdx = docNorm.indexOf(searchNorm);
        let matchLength = searchNorm.length;

        if (firstIdx === -1) {
            // Fallback: Fuzzy approximate substring matching
            const maxDistance = Math.max(2, Math.floor(searchNorm.length * 0.05));
            const bestSub = this.findBestFuzzySubstring(docNorm, searchNorm, maxDistance);

            if (bestSub.distance <= maxDistance && bestSub.endIndex !== -1) {
                // To find the exact start, search backwards from endIndex
                const textSubset = docNorm.substring(Math.max(0, bestSub.endIndex - searchNorm.length - maxDistance), bestSub.endIndex + 1);

                const revText = textSubset.split('').reverse().join('');
                const revPattern = searchNorm.split('').reverse().join('');
                const revBest = this.findBestFuzzySubstring(revText, revPattern, maxDistance);

                if (revBest.distance <= maxDistance && revBest.endIndex !== -1) {
                    firstIdx = bestSub.endIndex - revBest.endIndex;
                    matchLength = bestSub.endIndex - firstIdx + 1;
                    this.logChannel(`  -> Fuzzy match succeeded: distance ${bestSub.distance}/${maxDistance}`);
                }
            }
        }

        if (firstIdx === -1) {
            return { found: false, isAmbiguous: false };
        }

        const nextIdx = docNorm.indexOf(searchNorm, firstIdx + 1);
        if (nextIdx !== -1) {
            return { found: true, isAmbiguous: true };
        }

        const startOriginal = docObj.indexMap[firstIdx];
        const endOriginal = docObj.indexMap[firstIdx + matchLength];

        return { found: true, isAmbiguous: false, startOriginal, endOriginal };
    }

    private findBestFuzzySubstring(text: string, pattern: string, maxDistance: number): { endIndex: number, distance: number } {
        if (pattern.length === 0) return { endIndex: -1, distance: 0 };
        if (text.length === 0) return { endIndex: -1, distance: pattern.length };

        let prevRow = new Int32Array(pattern.length + 1);
        let currRow = new Int32Array(pattern.length + 1);
        for (let i = 0; i <= pattern.length; i++) prevRow[i] = i;

        let bestDistance = maxDistance + 1;
        let bestEndIndex = -1;

        for (let i = 0; i < text.length; i++) {
            currRow[0] = 0; // free start for substring search
            const textChar = text[i];

            for (let j = 0; j < pattern.length; j++) {
                const cost = textChar === pattern[j] ? 0 : 1;
                currRow[j + 1] = Math.min(
                    currRow[j] + 1,      // insertion
                    prevRow[j + 1] + 1,  // deletion
                    prevRow[j] + cost    // substitution
                );
            }

            if (currRow[pattern.length] < bestDistance) {
                bestDistance = currRow[pattern.length];
                bestEndIndex = i;
            }

            // Swap arrays
            const temp = prevRow;
            prevRow = currRow;
            currRow = temp;
        }

        return { endIndex: bestEndIndex, distance: bestDistance };
    }

    public async applyChanges(changes: FileChange[]): Promise<boolean> {
        if (changes.length === 0) { return false; }

        // Resolve and validate all paths upfront
        const resolvedChanges: { change: FileChange; uri: vscode.Uri }[] = [];
        for (const change of changes) {
            const resolvedPath = path.resolve(this.workspaceRoot, change.filePath);
            if (!resolvedPath.startsWith(this.workspaceRoot + path.sep) && resolvedPath != this.workspaceRoot) {
                this.logChannel(`BLOCKED path traversal attempt: ${change.filePath}`);
                vscode.window.showWarningMessage(`Agentic Gatekeeper: Blocked unsafe path from AI: ${change.filePath}`);
                continue;
            }
            resolvedChanges.push({ change, uri: vscode.Uri.file(resolvedPath) });
        }

        if (resolvedChanges.length === 0) { return false; }

        // Warn if any file has unsaved changes
        const dirtyFiles = resolvedChanges.filter(({ uri }) => {
            const openDoc = vscode.workspace.textDocuments.find(
                (doc: vscode.TextDocument) => doc.uri.fsPath === uri.fsPath && doc.isDirty
            );
            return !!openDoc;
        });

        if (dirtyFiles.length > 0) {
            const filenames = dirtyFiles.map(f => f.change.filePath).join(', ');
            const choice = await vscode.window.showWarningMessage(
                `Agentic Gatekeeper: ${dirtyFiles.length} file(s) have unsaved changes and will be overwritten: ${filenames}. Proceed?`,
                'Overwrite', 'Cancel'
            );
            if (choice !== 'Overwrite') {
                this.logChannel('Patch cancelled - unsaved changes would be overwritten.');
                return false;
            }
        }

        const edit = new vscode.WorkspaceEdit();

        for (const { change, uri } of resolvedChanges) {
            // Check if the file already exists
            let fileExists = true;
            try {
                await vscode.workspace.fs.stat(uri);
            } catch {
                fileExists = false;
            }

            if (fileExists) {
                try {
                    const document = await vscode.workspace.openTextDocument(uri);
                    const originalText = document.getText();

                    // Reject no-op rewrites (identical content modulo whitespace)
                    if (change.newContent.trim() === originalText.trim()) {
                        this.logChannel(`REJECTED ${change.filePath} rewrite - content is identical to original (no-op).`);
                        continue;
                    }

                    // Size Guardrail for Full Rewrites
                    const originalLength = document.getText().length;
                    const newLength = change.newContent.length;

                    if (originalLength > 0 && newLength < (originalLength * 0.70)) {
                        this.logChannel(`REJECTED ${change.filePath} rewrite - suspicious size reduction (${originalLength} -> ${newLength} chars). Possible AI truncation.`);
                        vscode.window.showWarningMessage(`Agentic Gatekeeper: Rejected rewrite of ${change.filePath} because the new content is >30% smaller. This indicates the AI truncated the file.`);
                        continue;
                    }

                    const fullRange = new vscode.Range(
                        document.positionAt(0),
                        document.positionAt(originalLength)
                    );

                    let cleanReplace = change.newContent;
                    if (/^```[a-zA-Z]*\s*\n/.test(cleanReplace) && /\n\s*```$/.test(cleanReplace)) {
                        cleanReplace = cleanReplace.replace(/^```[a-zA-Z]*\s*\n/, '').replace(/\n\s*```$/, '');
                    }

                    edit.replace(uri, fullRange, cleanReplace);
                } catch (err) {
                    this.logChannel(`Cannot open ${change.filePath}: ${err}`);
                    vscode.window.showWarningMessage(
                        `Agentic Gatekeeper: Cannot patch ${change.filePath} - file is inaccessible. Skipping.`
                    );
                }
            } else {
                edit.createFile(uri, { ignoreIfExists: false });
                edit.insert(uri, new vscode.Position(0, 0), change.newContent);
            }
        }

        const success = await vscode.workspace.applyEdit(edit);

        if (success) {
            for (const { change, uri } of resolvedChanges) {
                try {
                    const document = await vscode.workspace.openTextDocument(uri);
                    await document.save();
                } catch (e) {
                    this.logChannel(`Failed to save ${change.filePath}: ${e}`);
                }
            }
        }

        return success;
    }

    public async applyPatches(patches: FilePatch[]): Promise<boolean> {
        if (patches.length === 0) { return false; }

        const edit = new vscode.WorkspaceEdit();
        let anyFilesPatched = false;

        for (const filePatch of patches) {
            const resolvedPath = path.resolve(this.workspaceRoot, filePatch.filePath);
            if (!resolvedPath.startsWith(this.workspaceRoot + path.sep) && resolvedPath != this.workspaceRoot) {
                this.logChannel(`BLOCKED path traversal attempt: ${filePatch.filePath}`);
                continue;
            }

            const uri = vscode.Uri.file(resolvedPath);
            let document: vscode.TextDocument;

            try {
                document = await vscode.workspace.openTextDocument(uri);
            } catch (err) {
                this.logChannel(`Cannot open ${filePatch.filePath} for patching: ${err}`);
                continue;
            }

            if (document.isDirty) {
                this.logChannel(`SKIPPED ${filePatch.filePath} - file has unsaved changes.`);
                vscode.window.showWarningMessage(`Agentic Gatekeeper: Skipped patching ${filePatch.filePath} because it has unsaved changes.`);
                continue;
            }

            const originalText = document.getText();
            let allMatchesSafe = true;

            // Map to store validated replacements for this document
            const validatedEdits: { range: vscode.Range, newText: string }[] = [];

            // Pre-calculate all ranges atomically
            for (const p of filePatch.patches) {
                const matchResult = this.findNormalizedMatch(originalText, p.search);

                if (!matchResult.found) {
                    this.logChannel(`ABORTING patches for ${filePatch.filePath}: Search string anchor not found in document.`);
                    vscode.window.showWarningMessage(`Agentic Gatekeeper: Could not patch ${filePatch.filePath}. A search block could not be located.`);
                    allMatchesSafe = false;
                    break;
                }

                if (matchResult.isAmbiguous) {
                    this.logChannel(`ABORTING patches for ${filePatch.filePath}: Search string anchor is ambiguous (multiple occurrences).`);
                    vscode.window.showWarningMessage(`Agentic Gatekeeper: Could not patch ${filePatch.filePath}. A search block appears multiple times.`);
                    allMatchesSafe = false;
                    break;
                }

                if (matchResult.startOriginal !== undefined && matchResult.endOriginal !== undefined) {
                    const startPos = document.positionAt(matchResult.startOriginal);
                    const endPos = document.positionAt(matchResult.endOriginal);
                    // Strip accidental markdown fences that AI models often hallucinate inside JSON string values
                    let cleanReplace = p.replace;
                    if (/^```[a-zA-Z]*\s*\n/.test(cleanReplace) && /\n\s*```$/.test(cleanReplace)) {
                        cleanReplace = cleanReplace.replace(/^```[a-zA-Z]*\s*\n/, '').replace(/\n\s*```$/, '');
                    }

                    // Match the search boundary logic: trim the replacement so we don't multiply boundary whitespace
                    cleanReplace = cleanReplace.trim();

                    validatedEdits.push({
                        range: new vscode.Range(startPos, endPos),
                        newText: cleanReplace
                    });
                } else {
                    allMatchesSafe = false;
                    break;
                }
            }

            if (allMatchesSafe && validatedEdits.length > 0) {
                let simulatedText = originalText;
                // Apply edits in reverse order to preserve positions
                const sortedEdits = [...validatedEdits].sort((a, b) =>
                    b.range.start.compareTo(a.range.start)
                );
                for (const ve of sortedEdits) {
                    const startOff = document.offsetAt(ve.range.start);
                    const endOff = document.offsetAt(ve.range.end);
                    simulatedText = simulatedText.slice(0, startOff) + ve.newText + simulatedText.slice(endOff);
                }

                if (originalText.length > 0 && simulatedText.trim().length < (originalText.length * 0.50)) {
                    this.logChannel(`REJECTED all patches for ${filePatch.filePath} - result is ${simulatedText.length} chars vs original ${originalText.length} chars (>50% reduction). Possible destructive patch.`);
                    vscode.window.showWarningMessage(
                        `Agentic Gatekeeper: Rejected patches for ${filePatch.filePath} - the patched file would be >50% smaller than the original.`
                    );
                    continue;
                }

                for (const validatedEdit of validatedEdits) {
                    edit.replace(uri, validatedEdit.range, validatedEdit.newText);
                }
                anyFilesPatched = true;
            }
        }

        if (anyFilesPatched) {
            const success = await vscode.workspace.applyEdit(edit);
            if (success) {
                // Save edited files
                for (const filePatch of patches) {
                    const resolvedPath = path.resolve(this.workspaceRoot, filePatch.filePath);
                    try {
                        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(resolvedPath));
                        if (document.isDirty) { await document.save(); }
                    } catch (e) {
                        // non-fatal
                    }
                }
            }
            return success;
        }

        return false;
    }

    private logChannel(msg: string) {
        this.outputChannel?.appendLine(`[Patcher] ${msg}`);
        console.log(`[WorkspacePatcher] ${msg}`);
    }
}
