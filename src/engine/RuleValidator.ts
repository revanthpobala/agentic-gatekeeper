import * as vscode from 'vscode';
import { Minimatch } from 'minimatch';
import { AIProviderFactory } from '../ai/AIProviderFactory';
import { MarkdownParser } from './MarkdownParser';

export interface RuleValidationResult {
    filename: string;
    structuralIssues: string[];
    enforceable: 'YES' | 'PARTIALLY' | 'NO' | 'ERROR';
    targets: string;
    violationExample: string;
    compliantExample: string;
}

interface SemanticAuditResponse {
    enforceable: 'YES' | 'PARTIALLY' | 'NO';
    targets: string;
    violation_example: string;
    compliant_example: string;
}

function buildValidatorSystemPrompt(): string {
    return `You are a coding rule auditor. Your job is to evaluate whether a rule is specific enough to be automatically enforced on source code by an LLM.

Respond ONLY with a JSON object in this exact format — no prose, no markdown fences:
{
  "enforceable": "YES" | "PARTIALLY" | "NO",
  "targets": "<language or file type this rule applies to>",
  "violation_example": "<short code snippet that violates the rule>",
  "compliant_example": "<short code snippet that complies with the rule>"
}

Criteria:
- YES: The rule provides clear technical directives that an AI can reasonably understand and enforce. Natural language is perfectly fine.
- PARTIALLY: The core technical directive is unclear, mixes conflicting instructions, or requires heavy assumption.
- NO: The rule is entirely philosophical, non-technical, or impossible to enforce via static code changes (e.g., "write good code", "be a team player").

NOTE: Be highly lenient. Prefer YES unless the rule is genuinely useless for automated code patching.`;
}

function buildValidatorUserPrompt(ruleContent: string): string {
    return `Evaluate this rule:\n\n---\n${ruleContent}\n---`;
}

/**
 * Strips the provenance comment header written by RemoteRulesSyncer
 * before sending rule content to the LLM, so it doesn't affect evaluation.
 */
function stripProvenanceHeader(content: string): string {
    return content.replace(/^<!--[\s\S]*?-->\n?/, '').trim();
}

function checkStructural(content: string, globs?: string): string[] {
    const issues: string[] = [];

    const stripped = stripProvenanceHeader(content);

    // Empty content check — strip frontmatter at the START of the string only
    // using ^ anchor to avoid incorrectly stripping into the rule body
    // when horizontal rules (---) appear in the content.
    if (stripped.replace(/^---[\s\S]*?---\s*/, '').trim().length < 20) {
        issues.push('Rule has fewer than 20 characters of content — likely empty or placeholder.');
    }

    // Frontmatter globs validity
    if (globs) {
        const patterns = globs.split(',').map(p => p.trim());
        for (const p of patterns) {
            try {
                const m = new Minimatch(p);
                if (m.set.length === 0) {
                    issues.push(`Frontmatter glob "${p}" is invalid or matches nothing.`);
                }
            } catch {
                issues.push(`Frontmatter glob "${p}" failed to parse.`);
            }
        }
    }

    // Non-UTF8 bytes (surrogate pairs or null bytes indicate encoding corruption)
    if (/\uFFFD|\x00/.test(content)) {
        issues.push('Rule file contains non-UTF8 or null bytes — may corrupt LLM prompt.');
    }

    return issues;
}

function parseSemanticResponse(raw: string): SemanticAuditResponse | null {
    // Strip any accidental markdown fences
    const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    // Scan for the first valid JSON object rather than using a greedy regex.
    // A greedy /\{[\s\S]*\}/ would consume trailing braces inside code examples
    // in "violation_example" or "compliant_example" fields and break JSON.parse.
    let depth = 0;
    let start = -1;
    for (let i = 0; i < cleaned.length; i++) {
        if (cleaned[i] === '{') {
            if (depth === 0) { start = i; }
            depth++;
        } else if (cleaned[i] === '}') {
            depth--;
            if (depth === 0 && start !== -1) {
                const candidate = cleaned.slice(start, i + 1);
                try {
                    return JSON.parse(candidate) as SemanticAuditResponse;
                } catch {
                    // Not valid JSON at this brace pair — keep scanning
                    start = -1;
                }
            }
        }
    }
    return null;
}

export class RuleValidator {
    constructor(
        private workspaceRoot: string,
        private outputChannel: vscode.OutputChannel
    ) { }

    private log(msg: string) {
        this.outputChannel.appendLine(`[Rule Validator] ${msg}`);
    }

    public async run(): Promise<void> {
        this.outputChannel.show(true);
        this.outputChannel.appendLine('\n--- Gatekeeper Rule Validation ---');

        // 1. Discover rules
        const parser = new MarkdownParser(this.workspaceRoot, this.outputChannel);
        const rules = await parser.getRuleContext();

        if (rules.length === 0) {
            this.log('No rule files found. Nothing to validate.');
            vscode.window.showWarningMessage(
                'Agentic Gatekeeper: No rule files found. Create rules first.',
                'Create Rules'
            ).then(action => {
                if (action === 'Create Rules') {
                    vscode.commands.executeCommand('agentic-gatekeeper.setupInstructions');
                }
            });
            return;
        }

        this.log(`Validating ${rules.length} rule file(s)...`);

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Agentic Gatekeeper: Validating Rules',
            cancellable: false
        }, async (progress) => {
            const stepSize = Math.floor(90 / rules.length);

            // 2. Set up the AI provider (same as normal runs)
            const { provider, modeName } = AIProviderFactory.createProvider(this.outputChannel);
            this.log(`Semantic checks using: ${modeName}`);

            // 3. Run structural checks synchronously, then semantic checks concurrently
            const config = vscode.workspace.getConfiguration('agenticGatekeeper');
            const maxConcurrent = config.get<number>('maxConcurrentRequests') || 5;

            const results: RuleValidationResult[] = [];

            // Structural pass — instant, no LLM
            progress.report({ message: 'Running structural checks…', increment: 5 });
            for (const rule of rules) {
                const structuralIssues = checkStructural(rule.content, rule.globs);
                results.push({
                    filename: rule.filename,
                    structuralIssues,
                    enforceable: 'NO', // placeholder until semantic pass
                    targets: '',
                    violationExample: '',
                    compliantExample: ''
                });
            }

            // Semantic pass — concurrent, respects maxConcurrentRequests
            const systemPrompt = buildValidatorSystemPrompt();
            let completed = 0;

            for (let i = 0; i < rules.length; i += maxConcurrent) {
                const batch = rules.slice(i, i + maxConcurrent);
                await Promise.all(batch.map(async (rule, batchIdx) => {
                    const resultIdx = i + batchIdx;
                    const stripped = stripProvenanceHeader(rule.content);
                    const userPrompt = buildValidatorUserPrompt(stripped);
                    try {
                        const response = await provider.execute(systemPrompt, userPrompt);
                        if (response.content) {
                            const parsed = parseSemanticResponse(response.content);
                            if (parsed) {
                                results[resultIdx].enforceable = parsed.enforceable;
                                results[resultIdx].targets = parsed.targets;
                                results[resultIdx].violationExample = parsed.violation_example;
                                results[resultIdx].compliantExample = parsed.compliant_example;
                            } else {
                                results[resultIdx].enforceable = 'ERROR';
                                results[resultIdx].targets = 'Could not parse LLM response.';
                            }
                        } else {
                            results[resultIdx].enforceable = 'ERROR';
                            results[resultIdx].targets = 'No response from provider.';
                        }
                    } catch (err: any) {
                        results[resultIdx].enforceable = 'ERROR';
                        results[resultIdx].targets = err.message;
                    }
                    completed++;
                    progress.report({
                        message: `Checked ${completed}/${rules.length}: ${rule.filename}`,
                        increment: stepSize
                    });
                }));
            }

            progress.report({ message: 'Building report…', increment: 5 });

            // 4. Show webview report + print to output
            this.showWebviewReport(results);
            this.printReport(results);

            // 5. Show notification
            const fullCount = results.filter(r => r.enforceable === 'YES').length;
            const partialCount = results.filter(r => r.enforceable === 'PARTIALLY').length;
            const noCount = results.filter(r => r.enforceable === 'NO').length;
            const errorCount = results.filter(r => r.enforceable === 'ERROR').length;
            const hasStructuralIssues = results.some(r => r.structuralIssues.length > 0);

            if (noCount === 0 && errorCount === 0 && partialCount === 0 && !hasStructuralIssues) {
                vscode.window.showInformationMessage(
                    `Agentic Gatekeeper: All ${fullCount} rule(s) are fully enforceable. ✅`
                );
            } else {
                const parts: string[] = [];
                if (fullCount > 0) { parts.push(`${fullCount} ✅ enforceable`); }
                if (partialCount > 0) { parts.push(`${partialCount} ⚠️ partial`); }
                if (noCount > 0) { parts.push(`${noCount} ❌ too vague`); }
                if (errorCount > 0) { parts.push(`${errorCount} 💥 API error`); }
                vscode.window.showWarningMessage(
                    `Agentic Gatekeeper: ${parts.join(', ')}. See Rule Report panel.`
                );
            }
        });
    }

    private printReport(results: RuleValidationResult[]): void {
        const LABEL: Record<RuleValidationResult['enforceable'], string> = {
            'YES': '✅ YES',
            'PARTIALLY': '⚠️  PARTIALLY',
            'NO': '❌ NO',
            'ERROR': '💥 ERROR',
        };

        this.outputChannel.appendLine('');
        this.outputChannel.appendLine('┌─────────────────────────────────────────────────────────┐');
        this.outputChannel.appendLine('│              RULE VALIDATION REPORT                     │');
        this.outputChannel.appendLine('└─────────────────────────────────────────────────────────┘');

        for (const r of results) {
            this.outputChannel.appendLine('');
            this.outputChannel.appendLine(`📄 ${r.filename}`);
            this.outputChannel.appendLine(`   Enforceable : ${LABEL[r.enforceable]}`);
            if (r.targets) {
                this.outputChannel.appendLine(`   Targets     : ${r.targets}`);
            }

            if (r.structuralIssues.length > 0) {
                this.outputChannel.appendLine('   Structural issues:');
                for (const issue of r.structuralIssues) {
                    this.outputChannel.appendLine(`     ⚠️  ${issue}`);
                }
            }

            if (r.enforceable === 'PARTIALLY' || r.enforceable === 'NO') {
                this.outputChannel.appendLine('   Consider tightening this rule to be more specific and measurable.');
            }

            if (r.violationExample) {
                this.outputChannel.appendLine('   Violation ex : ' + r.violationExample.replace(/\n/g, ' ').slice(0, 100));
            }
            if (r.compliantExample) {
                this.outputChannel.appendLine('   Compliant ex : ' + r.compliantExample.replace(/\n/g, ' ').slice(0, 100));
            }
        }

        const fullCount = results.filter(r => r.enforceable === 'YES').length;
        this.outputChannel.appendLine('');
        this.outputChannel.appendLine(`Summary: ${fullCount}/${results.length} rules fully enforceable.`);
        this.outputChannel.appendLine('─────────────────────────────────────────────────────────');
    }

    private showWebviewReport(results: RuleValidationResult[]): void {
        const panel = vscode.window.createWebviewPanel(
            'gatekeeperRuleReport',
            'Gatekeeper: Rule Report',
            vscode.ViewColumn.Beside,
            { enableScripts: false }
        );

        const BADGE: Record<RuleValidationResult['enforceable'], string> = {
            'YES': '<span class="badge yes">✅ Enforceable</span>',
            'PARTIALLY': '<span class="badge partial">⚠️ Partially</span>',
            'NO': '<span class="badge no">❌ Too Vague</span>',
            'ERROR': '<span class="badge error">💥 API Error</span>',
        };

        const rows = results.map(r => {
            const structural = r.structuralIssues.length > 0
                ? `<ul class="issues">${r.structuralIssues.map(i => `<li>⚠️ ${esc(i)}</li>`).join('')}</ul>`
                : '';
            const examples = (r.violationExample || r.compliantExample) ? `
                <div class="examples">
                    ${r.violationExample ? `<div class="ex-block bad"><strong>Violation:</strong><pre>${esc(r.violationExample)}</pre></div>` : ''}
                    ${r.compliantExample ? `<div class="ex-block good"><strong>Compliant:</strong><pre>${esc(r.compliantExample)}</pre></div>` : ''}
                </div>` : '';
            const hint = (r.enforceable === 'PARTIALLY' || r.enforceable === 'NO')
                ? `<p class="hint">💡 Consider tightening this rule to be more specific and measurable.</p>` : '';
            return `
            <div class="card">
                <div class="card-header">
                    <span class="filename">📄 ${esc(r.filename)}</span>
                    ${BADGE[r.enforceable]}
                </div>
                ${r.targets ? `<p class="targets"><strong>Targets:</strong> ${esc(r.targets)}</p>` : ''}
                ${structural}
                ${hint}
                ${examples}
            </div>`;
        }).join('');

        const fullCount = results.filter(r => r.enforceable === 'YES').length;
        const total = results.length;

        panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Rule Validation Report</title>
<style>
  body { font-family: var(--vscode-editor-font-family, monospace); padding: 16px; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); }
  h1 { font-size: 1.2em; margin-bottom: 4px; }
  .summary { background: var(--vscode-editorWidget-background); border-radius: 6px; padding: 10px 16px; margin-bottom: 20px; font-size: 0.95em; }
  .card { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 14px 18px; margin-bottom: 14px; }
  .card-header { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
  .filename { font-weight: bold; flex: 1; }
  .badge { font-size: 0.8em; padding: 2px 10px; border-radius: 12px; font-weight: 600; }
  .badge.yes { background: #1e4d2b; color: #4ec97b; }
  .badge.partial { background: #4a3800; color: #f5a623; }
  .badge.no { background: #4d1e1e; color: #f47067; }
  .badge.error { background: #3b1a3b; color: #d18bee; }
  .targets { margin: 4px 0; font-size: 0.9em; opacity: 0.85; }
  .issues { margin: 6px 0; padding-left: 18px; font-size: 0.88em; color: #f5a623; }
  .hint { margin: 8px 0 4px; font-size: 0.88em; opacity: 0.8; }
  .examples { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px; }
  .ex-block { border-radius: 6px; padding: 8px 12px; font-size: 0.82em; }
  .ex-block.bad { background: #2a1010; border-left: 3px solid #f47067; }
  .ex-block.good { background: #0e2a1a; border-left: 3px solid #4ec97b; }
  pre { margin: 4px 0 0; white-space: pre-wrap; word-break: break-word; }
</style>
</head>
<body>
<h1>🛡️ Gatekeeper Rule Report</h1>
<div class="summary">${fullCount}/${total} rules fully enforceable &nbsp;|&nbsp; ${new Date().toLocaleTimeString()}</div>
${rows}
</body></html>`;
    }
}

function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
