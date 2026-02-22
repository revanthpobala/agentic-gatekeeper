# Agentic Gatekeeper Changelog

All notable changes to the "agentic-gatekeeper" extension will be documented in this file.

## [1.1.2] - Polish & Metadata Stability

### Added
- Standardized Marketplace categories for better search discoverability.
- Enhanced system prompts for recursive subdirectory rule support.

## [1.1.2] - Professional Branding & SEO Expansion

### Added
- **Global Markdown Visibility**: Enhanced SEO metadata to ensure discoverability for Markdown users. Added `Education` category.
- **Branding Standardization**: Unified naming to **Agentic Gatekeeper** across all logs and UI for a premium feel.
- **Recursive Subdirectory Rules**: Refined AI system prompts to explicitly support deeply nested subdirectory rule application.

## [1.1.1] - Stability & Logic Fixes

### Fixed
- **Rule Discovery for .cursor/rules**: Fixed a critical bug where `vscode.workspace.findFiles` skipped dot-directories (due to gitignore/exclude settings) and incorrectly classified `.cursor/rules` as domain-scoped. Now treats all root dot-directories as Global.
- **Improved Result Reporting**: Fixed edge cases where AI provider errors could result in a false "Compliant" status.
- **Performance**: Optimized Git status checks to run once per analysis batch instead of twice.

## [1.1.0] - Performance & Transparency Update

### Added
- **Token Usage & Cost Audit**: Every run prints a detailed audit summary showing total tokens consumed, prompt/completion breakdown, API calls made, and estimated USD cost.
- **Smart Token Batching**: Files are intelligently grouped into batches based on a configurable token budget (`maxTokensPerBatch`, default 60K). Reduces redundant rule-token duplication — cutting input costs by up to 78% on large commits.
- **New Settings**: `maxTokensPerBatch` to control batch size per API request.

### Changed
- `IProvider.execute()` now returns a structured `ProviderResult` with token usage metadata and model identifier.
- System prompt updated to evaluate multiple staged files per request (multi-file batch analysis).
- Audit summary now displays `API Calls Made` to make batching efficiency visible.

### Fixed
- **Model Selection Crash**: Native IDE provider now skips known-broken models (`gpt-5-mini`) and auto-selects stable models via a preference list (`gpt-4.1` → `gpt-4o` → `claude-haiku-4.5`).
- **False Compliance Reporting**: Engine no longer reports "Code is fully compliant" when AI provider calls fail. Shows `"⚠️ INCOMPLETE"` warning instead.
- **Double-Path 404**: `UniversalOpenAIProvider` now strips `/chat/completions` from base URLs if users paste the full endpoint path (the SDK appends it automatically).
- **Custom Provider Auto-Detection**: Factory now auto-upgrades from Native IDE when the custom base URL is changed, not just the API key.

---

## [1.0.0] - Launch Release

### Added
- **Multi-Provider AI Core**: Full native support for Anthropic (Claude 4.6), OpenAI (GPT-5.3-Codex), Google Gemini 3, OpenRouter, and Local LLMs (Ollama / LM Studio).
- **Concurrent Auto-Patching**: Implemented powerful multi-threading engine to evaluate and natively patch multiple staged files simultaneously without blocking the UI.
- **Deep Rule Routing**: Added intelligent directory scanning that automatically applies Global Rules (`.gatekeeper/`, `AGENTS.md`) and contextual Local Rules (`**/*-instructions.md`) exactly where they belong.
- **Dry Run Mode**: Safe testing mode that evaluates code constraints and returns AI feedback in the terminal without modifying local files.
- **Cancellable Execution**: Integrated VS Code's native Notification Progress UI to allow seamless mid-flight cancellation of all AI operations.
- **Setup Initialization Command**: Added the `Agentic Gatekeeper: Create Agentic Rules Folder` command to instantly scaffold rule directories for new workspaces.

### Changed
- Rebuilt the Native IDE Provider to heavily cache inference instances, completely eliminating log spam.
- Upgraded the API Gateway to route specific OpenRouter HTTP-Referer headings for leaderboard rankings.
- Redesigned the primary extension Icon and Visual Settings UI for the Marketplace.

### Security
- API keys are now strictly isolated within the VS Code secure `workspaceConfiguration` environment.
- Extension defaults to Sequential Mode to inherently protect against vendor API rate-limits for new users.