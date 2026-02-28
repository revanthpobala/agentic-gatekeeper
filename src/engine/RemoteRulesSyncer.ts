import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as crypto from 'crypto';

export interface SyncedRuleEntry {
    filename: string;
    localPath: string;
    sourceUrl: string;
    sha: string;
    syncedAt: string;
}

interface WorkspaceStateMeta {
    sha: string;
    syncedAt: string;
    entries: SyncedRuleEntry[];
}

const STATE_KEY = 'gatekeeper:remoteRules:meta';

function sha256(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 12);
}

function buildProvenanceHeader(sourceUrl: string, sha: string, syncedAt: string): string {
    return [
        '<!--',
        '  ⚠️  DO NOT EDIT — Auto-synced by Agentic Gatekeeper',
        `  Source:  ${sourceUrl}`,
        `  Commit:  ${sha}`,
        `  Synced:  ${syncedAt}`,
        '-->',
        ''
    ].join('\n');
}

function fetchUrl(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
        if (!url.startsWith('https://')) {
            return reject(new Error(`Only HTTPS URLs are allowed. Got: ${url}`));
        }
        https.get(url, { headers: { 'User-Agent': 'Agentic-Gatekeeper' } }, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                const location = res.headers['location'];
                // Guard: only follow redirects to HTTPS targets
                if (location && location.startsWith('https://')) {
                    return fetchUrl(location).then(resolve, reject);
                }
                return reject(new Error(`Redirect to non-HTTPS or missing location for ${url}`));
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            }
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            res.on('error', reject);
        }).on('error', reject);
    });
}

/**
 * Resolves the default branch name for a GitHub repo, then fetches all .md
 * blobs under the specified folder path via the Git Trees API.
 */
async function fetchGitHubTree(
    owner: string,
    repo: string,
    folderPath: string,
    token?: string,
    enterpriseUrl?: string
): Promise<{ filePath: string; downloadUrl: string; blobSha: string }[]> {
    // Determine API and Raw base URLs
    const apiBase = enterpriseUrl ? `${enterpriseUrl.replace(/\/$/, '')}/api/v3` : 'https://api.github.com';
    const rawBase = enterpriseUrl ? `${enterpriseUrl.replace(/\/$/, '')}` : 'https://raw.githubusercontent.com';

    // Step 1: Resolve the default branch SHA to avoid "HEAD" being rejected by the trees API
    const repoApiUrl = `${apiBase}/repos/${owner}/${repo}`;
    const repoJson = JSON.parse(await fetchWithOptionalAuth(repoApiUrl, token, enterpriseUrl));
    const defaultBranch: string = repoJson.default_branch ?? 'main';

    // Step 2: Fetch the recursive tree using the resolved branch name
    const treeApiUrl = `${apiBase}/repos/${owner}/${repo}/git/trees/${defaultBranch}?recursive=1`;
    const treeJson = JSON.parse(await fetchWithOptionalAuth(treeApiUrl, token, enterpriseUrl));

    const results: { filePath: string; downloadUrl: string; blobSha: string }[] = [];
    const normalizedFolder = folderPath.replace(/\/$/, '');
    for (const item of treeJson.tree ?? []) {
        if (item.type !== 'blob') { continue; }
        if (!item.path.startsWith(normalizedFolder + '/')) { continue; }
        if (!item.path.endsWith('.md')) { continue; }
        const rawUrl = enterpriseUrl
            ? `${rawBase}/raw/${owner}/${repo}/${defaultBranch}/${item.path}`
            : `${rawBase}/${owner}/${repo}/${defaultBranch}/${item.path}`;
        results.push({ filePath: item.path, downloadUrl: rawUrl, blobSha: item.sha as string });
    }
    return results;
}

function fetchWithOptionalAuth(url: string, token?: string, enterpriseUrl?: string): Promise<string> {
    if (!token) { return fetchUrl(url); }
    return new Promise((resolve, reject) => {
        const u = new URL(url);

        // SECURITY: ONLY send the GitHub PAT to official GitHub domains or the user's Enterprise server.
        let isGitHubDomain = u.hostname.endsWith('github.com') || u.hostname.endsWith('githubusercontent.com');
        if (enterpriseUrl) {
            try {
                if (u.hostname === new URL(enterpriseUrl).hostname) {
                    isGitHubDomain = true;
                }
            } catch { /* malformed enterpriseUrl, ignore */ }
        }

        const headers: Record<string, string> = {
            'User-Agent': 'Agentic-Gatekeeper',
            'Accept': 'application/vnd.github+json'
        };

        if (isGitHubDomain && token) {
            headers['Authorization'] = `Bearer ${token}`;
        }

        https.get({
            hostname: u.hostname,
            path: u.pathname + u.search,
            headers: headers
        }, (res) => {
            if (res.statusCode !== 200) {
                return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            }
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            res.on('error', reject);
        }).on('error', reject);
    });
}

function isTtlExpired(syncedAt: string, ttlHours: number): boolean {
    const syncTime = new Date(syncedAt).getTime();
    const nowTime = Date.now();
    return (nowTime - syncTime) > ttlHours * 60 * 60 * 1000;
}

export class RemoteRulesSyncer {
    constructor(
        private workspaceRoot: string,
        private workspaceState: vscode.Memento,
        private outputChannel: vscode.OutputChannel,
        private secrets: vscode.SecretStorage
    ) { }

    private log(msg: string) {
        this.outputChannel.appendLine(`[Remote Sync] ${msg}`);
    }

    public getCachedEntries(): SyncedRuleEntry[] {
        const meta = this.workspaceState.get<WorkspaceStateMeta>(STATE_KEY);
        return meta?.entries ?? [];
    }

    public clearCache() {
        // Only clear the TTL/SHA cache, NOT the trusted-sources approval list.
        // The user shouldn't need to re-approve sources they already trusted just
        // because the cache was manually cleared.
        this.workspaceState.update(STATE_KEY, undefined);
    }

    private async checkHostTrust(urlStr: string): Promise<boolean> {
        try {
            const host = new URL(urlStr).hostname;
            if (['github.com', 'api.github.com', 'raw.githubusercontent.com'].includes(host)) {
                return true;
            }

            const config = vscode.workspace.getConfiguration('agenticGatekeeper');
            const enterpriseUrl = config.get<string>('githubEnterpriseUrl');
            if (enterpriseUrl && host === new URL(enterpriseUrl).hostname) {
                // If it's their configured GHE url, auto-trust
                return true;
            }

            const trustedHosts = this.workspaceState.get<string[]>('trustedHosts') ?? [];
            if (trustedHosts.includes(host)) {
                return true;
            }

            const answer = await vscode.window.showWarningMessage(
                `Agentic Gatekeeper is attempting to download remote rules from "${host}". Do you recognize and trust this server?`,
                { modal: true },
                'Yes, Allow',
                'No, Block'
            );

            if (answer === 'Yes, Allow') {
                trustedHosts.push(host);
                await this.workspaceState.update('trustedHosts', trustedHosts);
                return true;
            }
            return false;
        } catch {
            return false; // Bad URL
        }
    }

    /**
     * Main entry point. Determines which sync approach to use based on settings,
     * checks TTL + SHA, handles the diff modal on changes, and writes files to disk.
     * Returns the list of synced rule entries (for TreeView refresh and MarkdownParser).
     */
    public async sync(force = false): Promise<SyncedRuleEntry[]> {
        const config = vscode.workspace.getConfiguration('agenticGatekeeper');
        const rawUrls: string[] = config.get<string[]>('remoteRulesUrl') ?? [];
        const repoSetting: string = config.get<string>('remoteRulesRepo') ?? '';
        const ttlHours: number = config.get<number>('remoteRulesTtlHours') ?? 24;
        const enterpriseUrl: string | undefined = config.get<string>('githubEnterpriseUrl') || undefined;

        if (rawUrls.length === 0 && !repoSetting) {
            return [];
        }

        // Opt-out check: if the user explicitly disabled remote rules, respect it.
        const remoteEnabled = config.get<boolean>('remoteRulesEnabled') ?? true;
        if (!remoteEnabled) {
            this.log('⏭ Remote rules are disabled (agenticGatekeeper.remoteRulesEnabled = false).');
            return [];
        }

        // Resolve workspaceRoot lazily so it's never an empty string if the
        // extension activates before a workspace folder is opened.
        const workspaceRoot = this.workspaceRoot ||
            (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '');
        if (!workspaceRoot) {
            this.log('⚠ Cannot sync — no workspace folder is open.');
            return [];
        }

        const meta = this.workspaceState.get<WorkspaceStateMeta>(STATE_KEY);
        const now = new Date().toISOString();

        // TTL check — skip fetch if cache is still fresh (unless forced)
        if (!force && meta && !isTtlExpired(meta.syncedAt, ttlHours)) {
            this.log(`⏱ Cache valid (synced ${meta.syncedAt}). Skipping remote fetch.`);
            this.log(`   ↳ Using ${meta.entries.length} cached rule(s).`);
            return meta.entries;
        }

        this.log('🌐 Remote Rules Sync started...');

        // Collect (sourceUrl, rawContent, destinationFilename) from all configured sources
        const fetched: { sourceUrl: string; content: string; destFilename: string }[] = [];

        // Read PAT from settings (primary) or secrets store (legacy fallback)
        const settingsPat = config.get<string>('githubPat') ?? '';
        const secretsPat = await this.secrets.get('agenticGatekeeper.githubPat');
        const token = settingsPat || secretsPat || undefined;

        // Approach 1: raw URLs
        for (const url of rawUrls) {
            try {
                const isTrusted = await this.checkHostTrust(url);
                if (!isTrusted) {
                    this.log(`   ✖ Blocked fetch from untrusted host: ${url}`);
                    continue;
                }
                const content = await fetchWithOptionalAuth(url, token, enterpriseUrl);
                // Strip query string and hash before using as filename to avoid
                // invalid characters on disk (e.g. "rules.md?token=abc")
                const cleanPath = url.split('?')[0].split('#')[0];
                const destFilename = path.basename(cleanPath);
                fetched.push({ sourceUrl: url, content, destFilename });
            } catch (err: any) {
                this.log(`   ✖ Failed to fetch ${url}: ${err.message}`);
            }
        }

        // Approach 2: GitHub API tree sync
        if (repoSetting) {
            const match = repoSetting.match(/^([^/]+)\/([^:]+):(.+)$/);
            if (!match) {
                this.log(`   ✖ Invalid remoteRulesRepo format. Expected "owner/repo:path/to/folder".`);
            } else {
                const [, owner, repo, folder] = match;
                try {
                    // Check trust for API endpoint (especially if enterpriseUrl is customized)
                    const apiBase = enterpriseUrl ? `${enterpriseUrl.replace(/\/$/, '')}/api/v3` : 'https://api.github.com';
                    const isApiTrusted = await this.checkHostTrust(apiBase);
                    if (!isApiTrusted) {
                        this.log(`   ✖ Blocked GitHub tree fetch from untrusted API: ${apiBase}`);
                    } else {
                        const items = await fetchGitHubTree(owner, repo, folder, token, enterpriseUrl);
                        for (const item of items) {
                            const isItemTrusted = await this.checkHostTrust(item.downloadUrl);
                            if (!isItemTrusted) {
                                this.log(`   ✖ Blocked raw file fetch from untrusted host: ${item.downloadUrl}`);
                                continue;
                            }
                            const fileContent = await fetchWithOptionalAuth(item.downloadUrl, token, enterpriseUrl);
                            // Namespace the filename with its relative subfolder to prevent collisions
                            // e.g. "frontend/rules.md" → "frontend__rules.md" in .gatekeeper/
                            const normalizedFolder = folder.replace(/\/$/, '');
                            const relativePath = item.filePath.startsWith(normalizedFolder + '/')
                                ? item.filePath.slice(normalizedFolder.length + 1)
                                : item.filePath;
                            const safeFilename = relativePath.replace(/[\/\\]/g, '__');
                            fetched.push({ sourceUrl: item.downloadUrl, content: fileContent, destFilename: safeFilename });
                        }
                    }
                } catch (err: any) {
                    this.log(`   ✖ GitHub API sync failed: ${err.message}`);
                }
            }
        }

        if (fetched.length === 0) {
            this.log('   ⚠ No remote rules could be fetched.');
            return meta?.entries ?? [];
        }

        // Compute aggregate SHA across all fetched content
        const aggregateContent = fetched.map(f => f.sourceUrl + f.content).join('|');
        const newSha = sha256(aggregateContent);
        const oldSha = meta?.sha;

        // SHA change detection — non-modal flow:
        // 1. Open the diff tab immediately so the user can inspect changes.
        // 2. Show a non-blocking toast with Accept/Keep buttons alongside the diff.
        if (oldSha && oldSha !== newSha) {
            // Open diff tab first — user can read while deciding
            await this.showDiffForFirstChange(fetched, now);

            const action = await vscode.window.showInformationMessage(
                `Remote rules changed upstream (${oldSha} → ${newSha}). Accept the incoming version?`,
                { modal: false },
                'Accept & Sync',
                'Keep Current'
            );
            if (action !== 'Accept & Sync') {
                this.log(`   ℹ User kept current rules (SHA: ${oldSha}).`);
                return meta?.entries ?? [];
            }
        }

        // Write files to .gatekeeper/ with provenance headers
        const gatekeeperDir = path.join(workspaceRoot, '.gatekeeper');
        if (!fs.existsSync(gatekeeperDir)) {
            fs.mkdirSync(gatekeeperDir, { recursive: true });
        }

        const entries: SyncedRuleEntry[] = [];
        for (const { sourceUrl, content, destFilename } of fetched) {
            const localPath = path.join(gatekeeperDir, destFilename);
            const fileSha = sha256(content);
            const header = buildProvenanceHeader(sourceUrl, fileSha, now);
            const isNew = !fs.existsSync(localPath);
            fs.writeFileSync(localPath, header + content, 'utf8');
            const changeLabel = isNew ? '(new)' : '(updated ✓)';
            this.log(`   ↓ ${destFilename}  ←  ${sourceUrl}  ${changeLabel}`);
            entries.push({ filename: destFilename, localPath, sourceUrl, sha: fileSha, syncedAt: now });
        }

        // Persist metadata to workspaceState
        const newMeta: WorkspaceStateMeta = { sha: newSha, syncedAt: now, entries };
        await this.workspaceState.update(STATE_KEY, newMeta);

        this.log(`✅ Remote sync complete (${entries.length} file(s), SHA: ${newSha}).`);

        // First-sync opt-out toast: rules are applied automatically (opt-out model).
        // Give the user a non-blocking notification with an [Opt Out] button to
        // disable remote rules entirely via workspace settings.
        if (!oldSha && entries.length > 0) {
            const sources = [...new Set(entries.map(e => {
                try { return new URL(e.sourceUrl).hostname; } catch { return e.sourceUrl; }
            }))];
            vscode.window.showInformationMessage(
                `Agentic Gatekeeper: ${entries.length} remote rule(s) from ${sources.join(', ')} are now active.`,
                'View Rules',
                'Opt Out'
            ).then(async a => {
                if (a === 'View Rules') {
                    vscode.commands.executeCommand('agenticGatekeeper.remoteRules.focus');
                } else if (a === 'Opt Out') {
                    await vscode.workspace.getConfiguration('agenticGatekeeper')
                        .update('remoteRulesEnabled', false, vscode.ConfigurationTarget.Workspace);
                    this.log('⏭ Remote rules disabled by user via opt-out.');
                    vscode.window.showInformationMessage(
                        'Agentic Gatekeeper: Remote rules disabled. Re-enable via Settings → agenticGatekeeper.remoteRulesEnabled.'
                    );
                }
            });
        }

        return entries;
    }

    /**
     * Opens the incoming content of a fetched rule file in a read-only editor tab
     * so the user can inspect it before approving the first-sync trust gate.
     * Written as .txt so MarkdownParser never picks it up as a rule file.
     */
    private async previewFile(
        file: { sourceUrl: string; content: string; destFilename: string },
        workspaceRoot: string,
        now: string
    ): Promise<void> {
        const tmpDir = path.join(workspaceRoot, '.gatekeeper', '.sync-diff-tmp');
        fs.mkdirSync(tmpDir, { recursive: true });
        const baseName = file.destFilename.replace(/\.md$/, '');
        const previewPath = path.join(tmpDir, `PREVIEW__${baseName}.txt`);
        const content = buildProvenanceHeader(file.sourceUrl, sha256(file.content), now) + file.content;
        fs.writeFileSync(previewPath, content, 'utf8');
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(previewPath), {
            preview: true,
            viewColumn: vscode.ViewColumn.Beside
        });
    }

    /**
     * Opens a VS Code diff editor between the old local file and the incoming content.
     * Temp files are written as .txt (not .md) so MarkdownParser never treats them
     * as rule files during subsequent scans of .gatekeeper/.
     */
    private async showDiffForFirstChange(
        fetched: { sourceUrl: string; content: string; destFilename: string }[],
        now: string
    ): Promise<void> {
        // Resolve root same way as sync() to stay consistent
        const workspaceRoot = this.workspaceRoot ||
            (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '');
        if (!workspaceRoot) { return; }

        const first = fetched[0];
        const localPath = path.join(workspaceRoot, '.gatekeeper', first.destFilename);
        const oldContent = fs.existsSync(localPath)
            ? fs.readFileSync(localPath, 'utf8')
            : '(no existing file)';
        const incomingContent = buildProvenanceHeader(first.sourceUrl, sha256(first.content), now) + first.content;

        // Write temp files as .txt so MarkdownParser's .gatekeeper/*.md glob never picks them up
        const tmpDir = path.join(workspaceRoot, '.gatekeeper', '.sync-diff-tmp');
        fs.mkdirSync(tmpDir, { recursive: true });
        const baseName = first.destFilename.replace(/\.md$/, '');
        const oldTmp = path.join(tmpDir, `OLD__${baseName}.txt`);
        const newTmp = path.join(tmpDir, `INCOMING__${baseName}.txt`);
        fs.writeFileSync(oldTmp, oldContent, 'utf8');
        fs.writeFileSync(newTmp, incomingContent, 'utf8');

        await vscode.commands.executeCommand(
            'vscode.diff',
            vscode.Uri.file(oldTmp),
            vscode.Uri.file(newTmp),
            `Remote Rules Diff: ${first.destFilename} (OLD ← INCOMING)`
        );
    }
}
