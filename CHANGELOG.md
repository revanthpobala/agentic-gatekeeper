# Agentic Gatekeeper Changelog

All notable changes to the "agentic-gatekeeper" extension will be documented in this file.

## [1.3.0] - 2026-02-28
### Security & Compliance
- **GitHub Fine-Grained PAT Support:** Completely rerouted authenticated downloads to the internal GitHub Git Blobs REST API. This securely bypasses CDN blocks that were rejecting Fine-Grained PATs with a 404.
- **Protocol Downgrade Protection:** HTTP Redirect chains that attempt to route traffic outside of strict `https://` endpoints are physically blocked.
- **Infinite Redirect Loop Guards:** Built a hard maximum recursion depth (5 limit) into the sync engine to prevent malicious or misconfigured remote servers from stack overflowing the IDE Extension Host.

### Rules Discovery
- **Transparent Glob Migration:** Automatically migrates existing configurations from `.gatekeeper/*.md` to recursive `.gatekeeper/**/*.md`. Ensures seamless discovery of isolated remote rules for users upgrading from v1.2.x.
- **Perfect Garbage Collection:** Remote rules that are deleted from the upstream source are now immediately unlinked from the local cache cleanly. File edits correctly map to their existing provenance headers without destroying state.
- **Tamper Resistance:** SHA matching logic now individually asserts the literal physical disk presence `fs.existsSync` of every expected cached rule. Deleting a remote rule locally instantly shatters the short-circuit cache and restores the file.

## [1.2.0] - 2026-02-23
### Added
- **Streaming Execution Strategy**: Final fixes are applied and staged in real-time as batches resolve, drastically reducing perceived wait time.
- **Improved Patch Mode Reliability**: Implemented whitespace-agnostic fuzzy matching for search-and-replace anchors, ensuring >95% success rate on complex file structures.
- **.gatekeeperignore Support**: Added native support for gitignore-style exclusion files at the workspace root.
- **Rule Targeting (Globs)**: Added YAML frontmatter support to rule files (e.g., `globs: "src/**/*.ts"`) to restrict enforcement to specific file patterns.
- **Diff-Only Auto-Switch**: Files exceeding 1,000 lines automatically switch to a token-efficient "diff contest" mode.
- **Live Progress Visualization**: Replaced text logs with a native percentage-based progress bar.

### Fixed
- **Caching Logic Flaw**: Fixed a critical bug where compliant files within mixed-violation batches were not being cached.
- **No-Op as Compliance**: Identical AI rewrites are now correctly treated as compliance confirmation and cached, eliminating redundant retries.
- **Cancellation Safety**: Guaranteed that no file writes occur if the user cancels the analysis at any stage.
- **Audit Labels**: Clarified that estimated costs are approximate.

## [1.1.5] - 2026-02-22
### Fixed
- **Anti-Junk Defense**: Implemented a mandatory filter that rejects any AI suggested patches containing placeholders (e.g., "// existing code here", "FULL_REWRITTEN_CONTENT").
- **Stability**: Prevents accidental project corruption where AI models try to be "lazy" by returning partial files.

## [1.1.4] - 2026-02-22
### Added
- **Performance Sprint**: Introduced `agenticGatekeeper.contextDepth` setting (`full` vs `diff`).
  - `diff` mode provides ~10x-50x faster audits for large files by only analyzing staged changes.
- **Reliability Upgrade**: Introduced `agenticGatekeeper.executionStrategy` (`aggregated` | `continuous`).
  - `continuous` mode applies and stages fixes batch-by-batch, preserving progress if the AI provider fails.
- **Batch Telemetry**: Real-time token usage logging in the Output channel for better transparency.
- **Improved Parsing**: Robust JSON extraction logic that handles markdown blocks and conversational AI noise.

### Changed
- Lowered default `maxTokensPerBatch` to 20,000 to improve stability with local LLM providers (Ollama, LM Studio).
- Re-aligned Global vs Domain instruction hierarchy for absolute rigidity.

### Fixed
- Fatal '413 Request Entity Too Large' errors by implementing strict token budgeting.
- Concurrency "race conditions" in continuous execution mode.

## [1.1.3] - 2026-02-22
### Fixed
- **Empty Patch Syndrome**: Fixed an issue where the AI would report violations but fail to provide the actual code patch.
- **Batching Reliability**: Reduced the default token batch size by 50% (30k tokens) to ensure AI models have enough completion head-room to rewrite multiple files at once.
- **Improved Compliance Detection**: The engine now handles empty JSON results gracefully, treating them as compliant if no changes were actually requested.

## [1.1.2] - 2026-02-21
### Added
- **Professional Branding & SEO Expansion**: Unified naming to **Agentic Gatekeeper** across all logs and UI.
- **Standardized Marketplace Categories**: Better search discoverability.
- **Recursive Subdirectory Rules**: Refined AI system prompts to explicitly support deeply nested subdirectory rule application.

## [1.1.1] - 2026-02-21
### Fixed
- **Rule Discovery for .cursor/rules**: Fixed a critical bug where dot-directories were skipped.
- **Improved Result Reporting**: Fixed false "Compliant" status on provider errors.
- **Performance**: Optimized Git status checks.

## [1.1.0] - 2026-02-20
### Added
- **Token Usage & Cost Audit**: Detailed summary showing total tokens, breakdown, and USD cost.
- **Smart Token Batching**: Intelligent grouping to cut input costs.

### Changed
- `IProvider.execute()` now returns structured `ProviderResult`.
- System prompt updated for multi-file batch analysis.

## [1.0.0] - 2026-02-18
### Added
- **Multi-Provider AI Core**: Native support for Anthropic, OpenAI, Gemini, OpenRouter, and Local LLMs.
- **Concurrent Auto-Patching**: Powered multi-threading engine for simultaneous evaluation.
- **Deep Rule Routing**: Semantic application of Global and Local rules.
- **Launch Features**: Dry Run Mode, Cancellable Execution, and Setup Initialization.