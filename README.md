# Agentic Gatekeeper

A VS Code extension to validate and apply Markdown instructions to staged code autonomously via an AI Agent. Acting as a pre-commit hook, it ensures your code perfectly aligns with your project's architectural, stylistic, and security guidelines before it's checked in.

## Features

- Scans workspace for Markdown rule files (e.g. `AGENTS.md`)
- Extracts staged Git Diffs AND Full File contexts.
- Selectively evaluates rules against the content domain (e.g., TS rules only for TS files).
- Auto-patches non-compliant code using VS Code native workspace edits.
- Supports any major Large Language Model.

## Configuration & API Keys

The Agentic Gatekeeper requires an LLM backend to function. By default, it uses the **Native IDE Model** (Copilot/Gemini, if signed in). However, for maximum capability (or if using Cursor/Antigravity), you should configure an external provider.

### How to Configure
1. Open the Command Palette (`Cmd+Shift+P` on Mac).
2. Type and select: **`Agentic Gatekeeper: Configure API Key`**
3. This opens the VS Code Settings page under `Extensions > Agentic Gatekeeper`.

### Supported Providers

1. **AI Provider Dropdown**: Select your preferred engine (`Anthropic`, `Gemini`, `OpenAI`, `OpenRouter`, or `Custom (Ollama/Local)`).
2. **API Keys**: Enter your respective API key (e.g., `Anthropic API Key`, `OpenRouter API Key`).
3. **Model Strings**: You can override the default models (e.g., changing `gpt-4o` to `gpt-4-turbo`).

### Using Local Models (Ollama / LM Studio)
If you select **Custom (Ollama/Local)** in the AI Provider dropdown, configure the following settings:
- **Custom Base URL**: Your local server's path (e.g., `http://localhost:11434/v1` for Ollama).
- **Custom Model**: The name of the model you have downloaded locally (e.g., `llama3` or `qwen2.5-coder`).
- **Custom API Key**: Usually `lm-studio` or `ollama` (Local endpoints ignore this, but the OpenAI SDK requires a string).

### Using OpenRouter (DeepSeek)
OpenRouter allows you to pass custom headers to show up on their leaderboards.
- **OpenRouter Referer**: Your project's URL.
- **OpenRouter Title**: Your app's display name.

## Requirements

Ensure you have staged your git changes before pressing the Gatekeeper icon.

## Release Notes

### 0.1.3
Major Architecture Upgrade. Complete Multi-Provider support added (Anthropic, OpenRouter, Ollama). Refactored internal AI orchestration and instituted sequential rule evaluation logic. 
