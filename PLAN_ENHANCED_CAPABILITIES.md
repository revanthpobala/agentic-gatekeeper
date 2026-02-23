# Enhanced Capabilities: Stability & Feature Expansion

Implement "Result Caching" to optimize performance and "Violation Explanations" to provide better visibility into AI-driven changes. This phase also includes critical architectural hardening steps.

## User Review Required

> [!IMPORTANT]
> **Result Caching**: Analysis results will be cached based on file content and rule hashes. Files that previously passed and haven't changed will be skipped. A command to manually clear the cache will be added.
> **Batch Warning**: New guardrail: if a job exceeds 10 batches (high token cost), the user will be prompted before proceeding.

## Proposed Changes

### [extension.ts](src/extension.ts)
- Pass `context.workspaceState` to `GatekeeperEngine`.
- Wrap filesystem operations in `setupInstructions` with try/catch.
- [NEW] Add command `agentic-gatekeeper.clearCache` to purge `workspaceState` entries.

### [GatekeeperEngine.ts](src/engine/GatekeeperEngine.ts)
- **Result Caching**: Store ONLY compliant results in `workspaceState` (key: `gatekeeper:cache:<filePath>`). Do NOT cache files that required patches. Hash = `sha256(fileContent + consolidatedInstructions)`.
- **Sentinels**: Check for `OK` instead of `COMPLIANT`.
- **Filtering**: Skip `package-lock.json`, `yarn.lock`, `go.sum`, and binary formats.
- **Sequential Safety**: Set `hasErrors = true` in the sequential batch catch block to prevent false success reports.
- **Cost Guardrail**: Confirmation prompt if `batches.length > 10`.
- **Early Exit**: If `rules.length === 0`, stop execution and offer to create `.gatekeeper/global-rules.md`.
- **Violation Logging**: Output format: `-> Violations found in [file]: "[reason]" - Auto-fix mapped.`

### [AIAgent.ts](src/ai/AIAgent.ts)
- **Prompt Evolution**: Use `OK` sentinel. Forbid status words in `newContent`.
- **Reasoning Prompt**: Explicitly instruct the AI: "Each fix object MUST include a reason field explaining which rule was violated."
- **JSON Schema**: Add `reason` field as an optional string.
- **Reliability**: Implement 3-attempt retry loop for 429/503/network errors with exponential backoff.
### [BatchProcessor.ts](src/engine/BatchProcessor.ts)
- **Interface Update**: Finalize change of return type to `{ batches, skipped }` to allow graceful handling of oversized files.

### [WorkspacePatcher.ts](src/applier/WorkspacePatcher.ts)
- **Path Guard**: Ensure `path.resolve` results stay within `workspaceRoot`.
- **Hardened Parsing**: Support bare JSON, fenced blocks, and outermost bracket scanning. Validate schema shape.
- **Junk Filter**: Use regex to reject `newContent` that matches status words (`ok`, `fixed`, etc.).
- **Atomic Creation**: Check file existence with `fs.stat` before choosing `replace` vs `createFile` to prevent duplicates.
- **Interactive Safety**: Verify `isDirty` status on open documents before overwriting.

### [AI Providers](src/ai/)
- **Fallbacks**: Remove local fallbacks for API keys in `execute()`—require keys from factory.
- **Fail-Fast**: Return `{ content: null }` with an error message immediately if keys are missing.
- **Gemini**: Correct key mapping to `gemini.model` (lowercase 'g') to match `package.json`.

### [MarkdownParser.ts](src/engine/MarkdownParser.ts)
- Replace all `Sync` filesystem calls with `fs.promises` / `vscode.workspace.fs`.

### [GitContext.ts](src/engine/GitContext.ts)
- Implement `checkIsRepo()` and ensure it is called before fetching status.

### [package.json](package.json)
- Sync `default` rules: ensure `agents.md` (lowercase) is included to match `MarkdownParser` defaults.

## Phase 3: Bug Audit & Hardening

Addresses issues identified during post-implementation audit.

### AIAgent & Providers
- **Retry Loop Restoration**: Providers will now throw transient errors (429, 503, network) instead of catching them and returning `null`. Configuration errors (missing keys) will still return `null` to fail fast.

### MarkdownParser
- **OS-Agnostic Classification**: Use `path.sep` and normalize all paths to forward slashes before classification to ensure reliable rule application on Windows.

### GatekeeperEngine
- **Model-Aware Caching**: Include the active `model` ID in the caching hash. This ensures that switching models (e.g., from Gemini to Claude) invalidates the cache, as different models have varying degrees of rule-following precision.

### WorkspacePatcher
- **JSON Sanitization**: Implement a simple regex to strip trailing commas from AI-generated JSON before parsing, increasing resilience to common LLM formatting slips.

## Verification Plan

### Automated Tests
- Run `npm test` to ensure core parsing and batching remain functional.
- **Update Tests**: Align `agent.test.ts` and `batching.test.ts` with the `OK` sentinel and the new `BatchResult` return structure.
- **Caching Tests**: Add unit tests for the caching logic (mocking `workspaceState`).

### Manual Verification
- Test caching: Run Gatekeeper twice on the same staged files; the second run should be nearly instantaneous.
- Test violation explanations: Verify the output panel displays the "reason" for each suggested fix.
