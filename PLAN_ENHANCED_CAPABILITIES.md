# Enhanced Capabilities: Stability & Feature Expansion

Implement "Result Caching" to optimize performance and "Violation Explanations" to provide better visibility into AI-driven changes. This phase also includes critical architectural hardening steps.

## User Review Required

> [!IMPORTANT]
> **Result Caching**: Analysis results will be cached based on file content and rule hashes. Files that previously passed and haven't changed will be skipped. A command to manually clear the cache will be added.
> **Batch Warning**: New guardrail: if a job exceeds 10 batches (high token cost), the user will be prompted before proceeding.

## Proposed Changes

### [extension.ts](file:///Users/revanth/My-Code/Agentic%20Gatekeeper/agentic-gatekeeper/src/extension.ts)
- Pass `context.workspaceState` to `GatekeeperEngine`.
- Wrap filesystem operations in `setupInstructions` with try/catch.
- [NEW] Add command `agentic-gatekeeper.clearCache` to purge `workspaceState` entries.

### [GatekeeperEngine.ts](file:///Users/revanth/My-Code/Agentic%20Gatekeeper/agentic-gatekeeper/src/engine/GatekeeperEngine.ts)
- **Result Caching**: Store compliant results in `workspaceState` using key `gatekeeper:cache:<filePath>`. Hash = `sha256(fileContent + consolidatedInstructions)`.
- **Sentinels**: Check for `OK` instead of `COMPLIANT`.
- **Filtering**: Skip `package-lock.json`, `yarn.lock`, `go.sum`, and binary formats (images, fonts).
- **Cost Guardrail**: Confirmation prompt if `batches.length > 10`.
- **Early Exit**: If `rules.length === 0`, stop execution and offer to create `.gatekeeper/global-rules.md`.
- **Violation Logging**: Output format: `-> Violations found in [file]: "[reason]" - Auto-fix mapped.`

### [AIAgent.ts](file:///Users/revanth/My-Code/Agentic%20Gatekeeper/agentic-gatekeeper/src/ai/AIAgent.ts)
- **Prompt Evolution**: Use `OK` sentinel. Forbid status words in `newContent`.
- **JSON Schema**: Add `reason` field as an optional string.
- **Reliability**: Implement 3-attempt retry loop for 429/503/network errors with exponential backoff.

### [WorkspacePatcher.ts](file:///Users/revanth/My-Code/Agentic%20Gatekeeper/agentic-gatekeeper/src/applier/WorkspacePatcher.ts)
- **Path Guard**: Ensure `path.resolve` results stay within `workspaceRoot`.
- **Hardened Parsing**: Support bare JSON, fenced blocks, and outermost bracket scanning. Validate schema shape.
- **Junk Filter**: Use regex to reject `newContent` that matches status words (`ok`, `fixed`, etc.).
- **Atomic Creation**: Check file existence with `fs.stat` before choosing `replace` vs `createFile` to prevent duplicates.
- **Interactive Safety**: Verify `isDirty` status on open documents before overwriting.

### [AI Providers](file:///Users/revanth/My-Code/Agentic%20Gatekeeper/agentic-gatekeeper/src/ai/)
- **Fallbacks**: Remove local fallbacks for API keys in `execute()`—require keys from factory.
- **Fail-Fast**: Return `{ content: null }` with an error message immediately if keys are missing.
- **Gemini**: Correct key mapping to `Gemini.model` (unified with factory).

### [MarkdownParser.ts](file:///Users/revanth/My-Code/Agentic%20Gatekeeper/agentic-gatekeeper/src/engine/MarkdownParser.ts)
- Replace all `Sync` filesystem calls with `fs.promises` / `vscode.workspace.fs`.

### [GitContext.ts](file:///Users/revanth/My-Code/Agentic%20Gatekeeper/agentic-gatekeeper/src/engine/GitContext.ts)
- Implement `checkIsRepo()` and ensure it is called before fetching status.

### [package.json](file:///Users/revanth/My-Code/Agentic%20Gatekeeper/agentic-gatekeeper/package.json)
- Sync `default` rules: ensure `agents.md` (lowercase) is included to match `MarkdownParser` defaults.

## Verification Plan

### Automated Tests
- Run `npm test` to ensure core parsing and batching remain functional.
- Add specific unit tests for the caching logic (mocking `workspaceState`).

### Manual Verification
- Test caching: Run Gatekeeper twice on the same staged files; the second run should be nearly instantaneous.
- Test violation explanations: Verify the output panel displays the "reason" for each suggested fix.
