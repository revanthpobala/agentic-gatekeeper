# Technical Blueprint: Safe Patching for Large Files

Implement a "patch mode" to handle large files more reliably. Instead of rewriting entire files (which risk truncation and high cost), the AI will provide specific search-and-replace patches.

## Proposed Changes

### [AI Orchestration]

#### [MODIFY] [AIAgent.ts](src/ai/AIAgent.ts)
- Update `FileContext` to include `lineCount: number`.
- Modify `buildUserPrompt` to tag each file header:
  - `--- File: path/to/file.ts (REWRITE MODE) ---`
  - `--- File: path/to/large_file.ts (PATCH MODE - return search/replace patches only) ---`
- Implement `buildPatchSystemPrompt()`:
  - Instructs AI to return a JSON array of `FilePatch` objects.
  - Each `FilePatch` contains `filePath`, `reason`, and an array of `patches` (`search`/`replace` pairs).
  - **Strict Anchor Directive**: AI must include at least 2 lines of unchanged surrounding context above and below modified lines.
  - **Context Constraint**: Explicitly forbid targeting generic single-line statements without surrounding context.
  - Explicitly forbids placeholders or status words in `replace`.
- Modify `analyze` to select the system prompt based on a `batchMode` parameter.

#### [MODIFY] [GatekeeperEngine.ts](src/engine/GatekeeperEngine.ts)
- Populate `lineCount` when reading files.
- Determine `batchMode`: If **any** file in a batch exceeds `agenticGatekeeper.largeFileThreshold`, set `batchMode = 'patch'`.
- Route the AI response to the appropriate parser and applier:
  - `rewrite` -> `patcher.parseAIResponse` & `patcher.applyChanges`.
  - `patch` -> `patcher.parseAIPatchResponse` & `patcher.applyPatches`.

---

### [Workspace Patcher]

#### [MODIFY] [WorkspacePatcher.ts](src/applier/WorkspacePatcher.ts)
- Add interfaces:
  ```typescript
  export interface PatchOperation { search: string; replace: string; }
  export interface FilePatch { filePath: string; reason?: string; patches: PatchOperation[]; }
  ```
- Implement `parseAIPatchResponse(response: string)`:
  - Similar robust JSON extraction as `parseAIResponse`.
  - Validates the `FilePatch` shape.
- Implement `normalizeText(text: string): string`:
  - Standardizes line endings (`\r\n` -> `\n`), collapses multiple spaces/tabs into a single space, and trims.
- Implement `findNormalizedMatch(documentText: string, search: string): { found: boolean, isAmbiguous: boolean, range?: vscode.Range }`:
  - **Normalization**: Create a map of "Original Index -> Normalized Index" to allow mapping normalized match boundaries back to original document coordinates.
  - **Comparison**: Use a regex-based or sliding-window approach that is insensitive to whitespace variations and line endings.
  - **Ambiguity Check**: Ensure the normalized `search` string appears exactly once in the normalized `documentText`.
- Implement `filterPatches(patches: FilePatch[])`:
  - Rejects empty `search` strings.
  - Rejects junk/placeholders in `replace`.
  - Rejects no-op patches (`search === replace`).
- Implement `applyPatches(patches: FilePatch[])`:
  - **Transactionality**: For each file, pre-calculate all `vscode.Range` matches. If **any** match fails (not found or ambiguous), abort the entire file update.
  - **Native Application**: Feed all valid ranges into a single `vscode.WorkspaceEdit` to leverage VS Code's internal conflict resolution.
  - **Logging**: Log specific reasons for failure (e.g., "Anchor not found: <normalized_preview>") to the output channel.
- Add size guardrail to `applyChanges`:
  - Reject full rewrites if the new content is `< 70%` of the original size (likely truncation).

---

### [Configuration]

#### [MODIFY] [package.json](package.json)
- Add `agenticGatekeeper.largeFileThreshold` (default: 200).

---

## Verification Plan

### Automated Tests
- Create `src/test/suite/patcher_patch_mode.test.ts`:
  - `parseAIPatchResponse`: Validates JSON extraction and shape validation.
  - `applyPatches`: Mocks VS Code documents to verify bottom-up patch application, anchor matching, and failure handling.
  - `applyChanges` guardrail: Verifies rejection of truncated rewrites.
- Update `src/test/suite/agent.test.ts`:
  - Verify `batchMode` logic selects the correct system prompt.

**Run Tests Command:**
```bash
npm run test
```

### Manual Verification
1. Open a large file (>200 lines).
2. Create a violation (e.g., add a forbidden pattern).
3. Run `Agentic Gatekeeper: Analyze Staged Changes`.
4. Verify the output channel shows "Mode: patch" and applied successfully.
5. Verify the file was patched correctly without rewriting the whole content.
