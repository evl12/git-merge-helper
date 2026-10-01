import http from 'node:http';
import { URL } from 'node:url';

const PORT = Number.parseInt(process.env.PORT || '8787', 10);
const HOST = process.env.HOST || '127.0.0.1';
const BASE_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-GitHub-Token',
};

function sendJson(res, status, payload) {
  res.writeHead(status, BASE_HEADERS);
  res.end(JSON.stringify(payload));
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('Payload too large'));
      }
    });

    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON payload'));
      }
    });

    req.on('error', reject);
  });
}

function parseRepoFromInput(input) {
  const value = String(input || '').trim();
  if (!value) {
    throw new Error('Repository input is required');
  }

  const urlMatch = value.match(/^https?:\/\/github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/?#].*)?$/i);
  if (urlMatch) {
    return { owner: urlMatch[1], repo: urlMatch[2], repoInputType: 'remote-url' };
  }

  const slugMatch = value.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (slugMatch) {
    return { owner: slugMatch[1], repo: slugMatch[2], repoInputType: 'owner-repo' };
  }

  throw new Error('Use GitHub repository URL (https://github.com/owner/repo) or owner/repo format in Repository Path.');
}

function getToken(requestToken = '') {
  const fromRequest = String(requestToken || '').trim();
  if (fromRequest) {
    return fromRequest;
  }

  return process.env.GITHUB_TOKEN || '';
}

async function ghRequest(pathname, options = {}, requestToken = '') {
  const token = getToken(requestToken);
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...options.headers,
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`https://api.github.com${pathname}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const message = data?.message || `GitHub API error (${response.status})`;
    const err = new Error(message);
    err.status = response.status;
    err.details = data;
    throw err;
  }

  return data;
}

function parseConfig(body) {
  const flow = Array.isArray(body.flow)
    ? body.flow.map((s) => String(s).trim()).filter(Boolean)
    : ['sandbox', 'feature', 'development', 'qa'];

  const repoInfo = parseRepoFromInput(body.repoPath || '.');

  return {
    ...repoInfo,
    repoInput: body.repoPath,
    from: body.from ? String(body.from).trim() : flow[0],
    to: body.to ? String(body.to).trim() : flow[flow.length - 1],
    flow,
    mode: body.mode === 'pr' ? 'pr' : 'direct',
    deepMergeCheck: Boolean(body.deepMergeCheck),
    allowPendingCi: Boolean(body.allowPendingCi),
    allowFailedCi: Boolean(body.allowFailedCi),
  };
}

function buildTransitions(flow, from, to) {
  const start = flow.indexOf(from);
  const end = flow.indexOf(to);

  if (start < 0 || end < 0) {
    throw new Error('from/to branch not found in flow');
  }

  if (start >= end) {
    throw new Error('from branch must come before to branch in selected flow');
  }

  const transitions = [];
  for (let i = start; i < end; i += 1) {
    transitions.push({ source: flow[i], target: flow[i + 1] });
  }
  return transitions;
}

async function getCheckStatus(owner, repo, sha, requestToken = '') {
  try {
    const payload = await ghRequest(`/repos/${owner}/${repo}/commits/${sha}/check-runs`, {}, requestToken);
    const runs = Array.isArray(payload.check_runs) ? payload.check_runs : [];

    if (runs.length === 0) {
      return { status: 'NO_CHECKS', reason: 'No check-runs are configured for this commit.' };
    }

    const failedConclusions = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']);
    const hasPending = runs.some((r) => r.status !== 'completed');
    const hasFailed = runs.some((r) => failedConclusions.has(r.conclusion));

    if (hasFailed) {
      return { status: 'FAILED', reason: 'One or more checks failed.' };
    }

    if (hasPending) {
      return { status: 'PENDING', reason: 'One or more checks are still running.' };
    }

    return { status: 'PASSED', reason: 'All checks completed successfully.' };
  } catch (error) {
    return { status: 'UNKNOWN', reason: error.message || 'Unable to read check-runs.' };
  }
}

async function findOpenPr(owner, repo, source, target, requestToken = '') {
  const list = await ghRequest(`/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${source}`)}&base=${encodeURIComponent(target)}&per_page=1`, {}, requestToken);
  if (!Array.isArray(list) || list.length === 0) {
    return null;
  }
  return list[0];
}

function formatGitHubError(error) {
  const message = error?.message || 'GitHub operation failed.';
  const detailMessage = error?.details?.message ? ` ${error.details.message}` : '';
  const nested = Array.isArray(error?.details?.errors)
    ? ` ${error.details.errors.map((e) => e.message || JSON.stringify(e)).join(' | ')}`
    : '';

  return `${message}${detailMessage}${nested}`.trim();
}

function getAllowedMergeMethods(repoInfo) {
  const methods = [];
  if (repoInfo?.allow_merge_commit) {
    methods.push('merge');
  }
  if (repoInfo?.allow_squash_merge) {
    methods.push('squash');
  }
  if (repoInfo?.allow_rebase_merge) {
    methods.push('rebase');
  }
  return methods;
}

async function getRepoCapabilities(owner, repo, requestToken = '') {
  const repoInfo = await ghRequest(`/repos/${owner}/${repo}`, {}, requestToken);
  const allowedMergeMethods = getAllowedMergeMethods(repoInfo);

  return {
    repoInfo,
    permissions: repoInfo?.permissions || {},
    allowedMergeMethods,
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchMergeability(owner, repo, prNumber, requestToken = '') {
  for (let i = 0; i < 6; i += 1) {
    const pr = await ghRequest(`/repos/${owner}/${repo}/pulls/${prNumber}`, {}, requestToken);
    if (pr.mergeable !== null) {
      return pr;
    }
    await wait(900);
  }
  return ghRequest(`/repos/${owner}/${repo}/pulls/${prNumber}`, {}, requestToken);
}

async function ensureAuditPr(owner, repo, source, target, requestToken = '') {
  const existing = await findOpenPr(owner, repo, source, target, requestToken);
  if (existing) {
    const evaluated = await fetchMergeability(owner, repo, existing.number, requestToken);
    return { pr: evaluated, temporary: false };
  }

  const created = await ghRequest(`/repos/${owner}/${repo}/pulls`, {
    method: 'POST',
    body: {
      title: `[audit-temp] ${source} -> ${target}`,
      head: source,
      base: target,
      body: 'Temporary PR created by git-helper to evaluate mergeability. It may be auto-closed.',
      draft: true,
    },
  }, requestToken);

  const evaluated = await fetchMergeability(owner, repo, created.number, requestToken);
  return { pr: evaluated, temporary: true };
}

async function closePr(owner, repo, number, requestToken = '') {
  await ghRequest(`/repos/${owner}/${repo}/pulls/${number}`, {
    method: 'PATCH',
    body: { state: 'closed' },
  }, requestToken);
}

function readinessDecision({ ahead, mergeable, ciStatus, allowPendingCi, allowFailedCi }) {
  if (ahead === 0) {
    return { readiness: 'NO_CHANGES', reason: 'No commits to promote for this transition.' };
  }

  if (mergeable === false) {
    return { readiness: 'CONFLICT', reason: 'GitHub reports this branch pair as not mergeable.' };
  }

  if (ciStatus === 'FAILED' && !allowFailedCi) {
    return { readiness: 'BLOCKED_CI', reason: 'CI checks failed and policy blocks failed CI.' };
  }

  if (ciStatus === 'NO_CHECKS') {
    return { readiness: 'READY', reason: 'No CI checks are configured for this branch; allowing merge under no-checks policy.' };
  }

  if ((ciStatus === 'PENDING' || ciStatus === 'UNKNOWN') && !allowPendingCi) {
    return { readiness: 'BLOCKED_CI', reason: `CI status is ${ciStatus} and policy blocks pending/unknown checks.` };
  }

  return { readiness: 'READY', reason: 'Merge-ready under current policy.' };
}

async function evaluateTransition(config, transition, requestToken = '') {
  const compare = await ghRequest(`/repos/${config.owner}/${config.repo}/compare/${encodeURIComponent(transition.target)}...${encodeURIComponent(transition.source)}`, {}, requestToken);
  const ahead = Number(compare.ahead_by || 0);
  const behind = Number(compare.behind_by || 0);

  // The compare API has no head_commit field; resolve the source branch tip directly instead.
  let sourceSha = '';
  try {
    const branchInfo = await ghRequest(`/repos/${config.owner}/${config.repo}/branches/${encodeURIComponent(transition.source)}`, {}, requestToken);
    sourceSha = branchInfo?.commit?.sha || '';
  } catch {
    const commits = Array.isArray(compare.commits) ? compare.commits : [];
    sourceSha = commits.length > 0 ? commits[commits.length - 1]?.sha || '' : '';
  }

  const ci = sourceSha
    ? await getCheckStatus(config.owner, config.repo, sourceSha, requestToken)
    : { status: 'UNKNOWN', reason: 'Could not resolve source commit SHA.' };

  let mergeable = null;
  let mergeState = 'not-evaluated';
  const conflictFiles = [];
  let temporaryPrNumber = null;

  try {
    const openPr = await findOpenPr(config.owner, config.repo, transition.source, transition.target, requestToken);
    if (openPr) {
      const evaluated = await fetchMergeability(config.owner, config.repo, openPr.number, requestToken);
      mergeable = evaluated.mergeable;
      mergeState = evaluated.mergeable_state || 'unknown';
    } else if (config.deepMergeCheck) {
      const { pr, temporary } = await ensureAuditPr(config.owner, config.repo, transition.source, transition.target, requestToken);
      mergeable = pr.mergeable;
      mergeState = pr.mergeable_state || 'unknown';
      temporaryPrNumber = temporary ? pr.number : null;
    }
  } catch (error) {
    mergeable = null;
    mergeState = `unknown (${formatGitHubError(error)})`;
  }

  const decision = readinessDecision({
    ahead,
    mergeable,
    ciStatus: ci.status,
    allowPendingCi: config.allowPendingCi,
    allowFailedCi: config.allowFailedCi,
  });

  const row = {
    source: transition.source,
    target: transition.target,
    ahead,
    behind,
    ciStatus: ci.status,
    ciReason: ci.reason,
    readiness: decision.readiness,
    readinessReason: `${decision.reason} mergeable_state=${mergeState}${config.deepMergeCheck ? ' deep-check=on' : ' deep-check=off'}`,
    conflictedFiles: conflictFiles,
    sourceSha,
    mergeable,
    mergeState,
    temporaryPrNumber,
  };

  if (temporaryPrNumber) {
    await closePr(config.owner, config.repo, temporaryPrNumber, requestToken);
  }

  return row;
}

async function auditTransitions(config, requestToken = '') {
  const transitions = buildTransitions(config.flow, config.from, config.to);
  const rows = [];

  for (const t of transitions) {
    const row = await evaluateTransition(config, t, requestToken);
    rows.push(row);
  }

  const blockedRows = rows.filter((r) => r.readiness === 'BLOCKED_CI' || r.readiness === 'CONFLICT');
  return { rows, blocked: blockedRows.length > 0, blockedRows };
}

async function mergeTransition(config, source, target, requestToken = '') {
  const capabilities = await getRepoCapabilities(config.owner, config.repo, requestToken);
  const canPush = Boolean(capabilities.permissions?.push || capabilities.permissions?.admin || capabilities.permissions?.maintain);
  if (!canPush) {
    throw new Error('Token user does not have write permission on this repository. Merge requires push/maintain/admin permission.');
  }

  if (capabilities.allowedMergeMethods.length === 0) {
    throw new Error('No merge methods are enabled in repository settings. Enable at least one of merge, squash, or rebase.');
  }

  let pr = await findOpenPr(config.owner, config.repo, source, target, requestToken);

  if (!pr) {
    pr = await ghRequest(`/repos/${config.owner}/${config.repo}/pulls`, {
      method: 'POST',
      body: {
        title: `Promote ${source} -> ${target}`,
        head: source,
        base: target,
        body: `Automated promotion from ${source} to ${target}`,
        draft: false,
      },
    }, requestToken);
  }

  const evaluated = await fetchMergeability(config.owner, config.repo, pr.number, requestToken);
  if (evaluated.mergeable === false) {
    const mergeState = evaluated.mergeable_state || 'unknown';
    throw new Error(`Pull request is not mergeable. mergeable_state=${mergeState}. Resolve conflicts or branch protection requirements.`);
  }

  let merged = null;
  let lastError = null;

  for (const mergeMethod of capabilities.allowedMergeMethods) {
    try {
      merged = await ghRequest(`/repos/${config.owner}/${config.repo}/pulls/${pr.number}/merge`, {
        method: 'PUT',
        body: {
          merge_method: mergeMethod,
          commit_title: `Promote ${source} -> ${target}`,
        },
      }, requestToken);
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (!merged) {
    const msg = lastError ? formatGitHubError(lastError) : 'Unknown merge failure.';
    throw new Error(`GitHub rejected merge for all enabled methods (${capabilities.allowedMergeMethods.join(', ')}). ${msg}`);
  }

  return {
    status: 'MERGED',
    transition: `${source} -> ${target}`,
    commit: merged.sha || '',
    timestampUtc: new Date().toISOString(),
    detail: merged.message || 'Merged successfully',
  };
}

async function promoteTransitions(config, audit, requestToken = '') {
  if (audit.blocked) {
    return {
      ok: false,
      finalStatus: 'PROMOTION_HALTED',
      reason: 'PRECHECK_BLOCKED',
      detail: 'At least one stage is blocked by CI policy or merge conflict.',
      blockedRows: audit.blockedRows,
    };
  }

  const executionLog = [];

  for (const row of audit.rows) {
    const liveRow = await evaluateTransition(config, { source: row.source, target: row.target }, requestToken);

    if (liveRow.readiness === 'NO_CHANGES') {
      executionLog.push({
        transition: `${liveRow.source} -> ${liveRow.target}`,
        status: 'SKIPPED_NO_CHANGES',
        detail: liveRow.readinessReason,
      });
      continue;
    }

    if (liveRow.readiness === 'BLOCKED_CI' || liveRow.readiness === 'CONFLICT') {
      return {
        ok: false,
        finalStatus: 'PROMOTION_HALTED',
        reason: liveRow.readiness,
        haltedAt: `${liveRow.source} -> ${liveRow.target}`,
        detail: liveRow.readinessReason,
        executionLog,
        blockedRows: [liveRow],
      };
    }

    try {
      const merged = await mergeTransition(config, liveRow.source, liveRow.target, requestToken);
      executionLog.push(merged);
    } catch (error) {
      return {
        ok: false,
        finalStatus: 'PROMOTION_HALTED',
        reason: 'MERGE_FAILED',
        haltedAt: `${liveRow.source} -> ${liveRow.target}`,
        detail: formatGitHubError(error),
        executionLog,
      };
    }
  }

  return {
    ok: true,
    finalStatus: 'PROMOTION_COMPLETE',
    mode: 'pr',
    executionLog,
  };
}

async function diagnostics(repoInput, requestToken = '') {
  let repo = null;
  try {
    repo = parseRepoFromInput(repoInput || '');
  } catch {
    repo = null;
  }

  const tokenSet = Boolean(getToken(requestToken));
  const tokenSource = String(requestToken || '').trim() ? 'request-header' : (process.env.GITHUB_TOKEN ? 'server-env' : 'none');
  let apiReachable = false;
  let authMessage = tokenSet
    ? 'GITHUB_TOKEN detected.'
    : 'GITHUB_TOKEN missing. Read-only public APIs may work with strict rate limits; merge operations will fail.';

  try {
    await ghRequest('/rate_limit', {}, requestToken);
    apiReachable = true;
  } catch (error) {
    apiReachable = false;
    authMessage = error.message || 'GitHub API not reachable.';
  }

  let repoAccess = null;
  let authActor = null;

  if (tokenSet) {
    try {
      const viewer = await ghRequest('/user', {}, requestToken);
      authActor = {
        login: viewer?.login || '-',
        id: viewer?.id || null,
      };
    } catch (error) {
      authActor = {
        login: null,
        id: null,
        error: formatGitHubError(error),
      };
    }
  }

  if (repo) {
    try {
      const { repoInfo, permissions, allowedMergeMethods } = await getRepoCapabilities(repo.owner, repo.repo, requestToken);
      repoAccess = {
        ok: true,
        visibility: repoInfo.private ? 'private' : 'public',
        defaultBranch: repoInfo.default_branch,
        permissions,
        allowedMergeMethods,
      };
    } catch (error) {
      repoAccess = { ok: false, message: error.message || 'Cannot access repository' };
    }
  }

  return {
    api: { status: apiReachable ? 'UP' : 'DOWN', message: authMessage },
    githubToken: { configured: tokenSet, source: tokenSource },
    authActor,
    repoAccess,
  };
}

async function handleRequest(req, res) {
  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {});
    return;
  }

  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const requestToken = String(req.headers['x-github-token'] || '').trim();

  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, service: 'github-api' });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/diagnostics') {
      const repoPath = url.searchParams.get('repoPath') || '';
      const report = await diagnostics(repoPath, requestToken);
      sendJson(res, 200, { ok: true, diagnostics: report });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/repo') {
      const repoPath = url.searchParams.get('repoPath') || '';
      const parsed = parseRepoFromInput(repoPath);

      const repoInfo = await ghRequest(`/repos/${parsed.owner}/${parsed.repo}`, {}, requestToken);
      const branches = await ghRequest(`/repos/${parsed.owner}/${parsed.repo}/branches?per_page=100`, {}, requestToken);
      const commits = await ghRequest(`/repos/${parsed.owner}/${parsed.repo}/commits?per_page=20`, {}, requestToken);

      sendJson(res, 200, {
        ok: true,
        repoInput: repoPath,
        repoInputType: parsed.repoInputType,
        repoPath: `${parsed.owner}/${parsed.repo}`,
        remote: 'github-api',
        status: {
          currentBranch: repoInfo.default_branch || '-',
          isClean: true,
          changedFiles: [],
        },
        branches: Array.isArray(branches) ? branches.map((b) => b.name) : [],
        recentCommits: Array.isArray(commits)
          ? commits.map((c) => ({
              sha: c.sha,
              shortSha: String(c.sha || '').slice(0, 8),
              authorName: c.commit?.author?.name || c.author?.login || 'Unknown',
              authorEmail: c.commit?.author?.email || '-',
              date: c.commit?.author?.date || '-',
              subject: c.commit?.message?.split('\n')[0] || '-',
            }))
          : [],
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/audit') {
      const body = await parseJsonBody(req);
      const config = parseConfig(body);
      const audit = await auditTransitions(config, requestToken);
      sendJson(res, 200, { ok: true, config, audit });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/promote') {
      const body = await parseJsonBody(req);
      const config = parseConfig(body);
      const audit = await auditTransitions(config, requestToken);
      const promotion = await promoteTransitions(config, audit, requestToken);

      sendJson(res, promotion.ok ? 200 : 409, {
        ok: promotion.ok,
        config,
        audit,
        promotion,
      });
      return;
    }

    sendJson(res, 404, { ok: false, error: 'Not found' });
  } catch (error) {
    const rawMessage = error.message || 'Unknown server error';
    const status = error.status || 500;
    const details = error.details || null;

    let friendlyMessage = rawMessage;

    if (status === 401 || status === 403) {
      friendlyMessage = 'GitHub API authorization failed. Provide a valid GitHub token with repo permissions.';
    } else if (status === 404 && rawMessage === 'Not Found') {
      friendlyMessage = 'Repository or branch resource was not found. Verify owner/repo path, branch names, and token access (required for private repos).';
    }

    sendJson(res, status, {
      ok: false,
      error: friendlyMessage,
      details,
    });
  }
}

const server = http.createServer((req, res) => {
  handleRequest(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`GitHub API server running at http://${HOST}:${PORT}`);
});
