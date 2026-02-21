# Agentic Gatekeeper Changelog

All notable changes to the "agentic-gatekeeper" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - Viral Launch Release

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