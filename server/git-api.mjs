import http from 'node:http';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { URL } from 'node:url';

const PORT = 8787;
const HOST = '127.0.0.1';

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
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

    req.on('error', (err) => reject(err));
  });
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return {
    status: result.status ?? 1,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
  };
}

function git(repoPath, args, label) {
  const out = run('git', args, repoPath);
  if (out.status !== 0) {
    const err = new Error(`${label} failed`);
    err.details = {
      command: `git ${args.join(' ')}`,
      stdout: out.stdout,
      stderr: out.stderr,
      status: out.status,
    };
    throw err;
  }
  return out.stdout;
}

function gitTry(repoPath, args) {
  return run('git', args, repoPath);
}

function isRemoteRepoInput(value) {
  return /^(https?:\/\/|git@)/i.test(value);
}

function getRepoCacheRoot() {
  return path.join(process.cwd(), '.repo-cache');
}

function normalizeRepoKey(remoteUrl) {
  return remoteUrl
    .replace(/^https?:\/\//i, '')
    .replace(/^git@/i, '')
    .replace(/[:/]/g, '_')
    .replace(/\.git$/i, '')
    .replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function prepareRemoteRepo(remoteUrl) {
  const cacheRoot = getRepoCacheRoot();
  fs.mkdirSync(cacheRoot, { recursive: true });

  const repoDir = path.join(cacheRoot, normalizeRepoKey(remoteUrl));
  const gitDir = path.join(repoDir, '.git');

  if (!fs.existsSync(gitDir)) {
    const clone = run('git', ['clone', remoteUrl, repoDir], process.cwd());
    if (clone.status !== 0) {
      throw new Error(`Failed to clone repository URL: ${clone.stderr || clone.stdout}`);
    }
  }

  const fetch = run('git', ['fetch', '--all', '--prune'], repoDir);
  if (fetch.status !== 0) {
    throw new Error(`Failed to fetch repository updates: ${fetch.stderr || fetch.stdout}`);
  }

  return repoDir;
}

function resolveRepoContext(inputPath) {
  const rawInput = inputPath && inputPath.trim().length > 0 ? inputPath.trim() : process.cwd();

  if (isRemoteRepoInput(rawInput)) {
    const repoPath = prepareRemoteRepo(rawInput);
    return {
      repoInput: rawInput,
      repoPath,
      inputType: 'remote-url',
    };
  }

  return {
    repoInput: rawInput,
    repoPath: path.resolve(rawInput),
    inputType: 'local-path',
  };
}

function ensureRepo(repoPath) {
  if (!fs.existsSync(repoPath)) {
    throw new Error(`Repository path does not exist: ${repoPath}`);
  }

  const check = gitTry(repoPath, ['rev-parse', '--is-inside-work-tree']);
  if (check.status !== 0 || check.stdout !== 'true') {
    throw new Error(`Not a git repository: ${repoPath}`);
  }
}

function getBranches(repoPath, remote) {
  const branchOut = git(repoPath, ['for-each-ref', '--format=%(refname:short)', `refs/remotes/${remote}`], 'List remote branches');
  return branchOut
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((name) => !name.endsWith('/HEAD'))
    .map((name) => name.replace(`${remote}/`, ''))
    .sort((a, b) => a.localeCompare(b));
}

function getRepoStatus(repoPath) {
  const branch = git(repoPath, ['branch', '--show-current'], 'Read current branch');
  const porcelain = git(repoPath, ['status', '--porcelain'], 'Read working tree status');
  const isClean = porcelain.length === 0;

  return {
    currentBranch: branch,
    isClean,
    changedFiles: porcelain
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  };
}

function getRecentCommits(repoPath, limit = 20) {
  const format = '%H%x09%an%x09%ae%x09%ad%x09%s';
  const logOut = git(
    repoPath,
    ['log', `-${limit}`, '--date=iso-strict', `--pretty=format:${format}`],
    'Read recent commits',
  );

  if (!logOut) {
    return [];
  }

  return logOut.split('\n').map((line) => {
    const [sha, authorName, authorEmail, date, subject] = line.split('\t');
    return {
      sha,
      shortSha: sha.slice(0, 8),
      authorName,
      authorEmail,
      date,
      subject,
    };
  });
}

function parseRepoSlugFromRemote(remoteUrl) {
  const match = remoteUrl.match(/[:/]([^/]+)\/([^/.]+)(\.git)?$/);
  if (!match) {
    return null;
  }
  return `${match[1]}/${match[2]}`;
}

function getRepoSlug(repoPath, remote) {
  const out = gitTry(repoPath, ['remote', 'get-url', remote]);
  if (out.status !== 0 || !out.stdout) {
    return null;
  }
  return parseRepoSlugFromRemote(out.stdout);
}

function getCiStatus(repoPath, remote, sourceBranch) {
  const repoSlug = getRepoSlug(repoPath, remote);
  if (!repoSlug) {
    return { status: 'UNKNOWN', reason: 'Missing remote owner/repo metadata' };
  }

  const ghVersion = run('gh', ['--version'], repoPath);
  if (ghVersion.status !== 0) {
    return { status: 'UNKNOWN', reason: 'gh CLI is unavailable' };
  }

  const sha = git(repoPath, ['rev-parse', `${remote}/${sourceBranch}`], 'Resolve source SHA');
  const checks = run('gh', ['api', `repos/${repoSlug}/commits/${sha}/check-runs`], repoPath);

  if (checks.status !== 0 || !checks.stdout) {
    return { status: 'UNKNOWN', reason: checks.stderr || 'Unable to load check-runs' };
  }

  let payload;
  try {
    payload = JSON.parse(checks.stdout);
  } catch {
    return { status: 'UNKNOWN', reason: 'Invalid check-runs response' };
  }

  const runs = Array.isArray(payload.check_runs) ? payload.check_runs : [];
  if (runs.length === 0) {
    return { status: 'UNKNOWN', reason: 'No CI checks found' };
  }

  const failed = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']);
  const hasPending = runs.some((r) => r.status !== 'completed');
  const hasFailed = runs.some((r) => failed.has(r.conclusion));

  if (hasFailed) {
    return { status: 'FAILED', reason: 'One or more checks failed' };
  }

  if (hasPending) {
    return { status: 'PENDING', reason: 'One or more checks are pending' };
  }

  return { status: 'PASSED', reason: 'Checks completed successfully' };
}

function getAheadBehind(repoPath, remote, source, target) {
  const value = git(repoPath, ['rev-list', '--left-right', '--count', `${remote}/${target}...${remote}/${source}`], 'Compute ahead behind');
  const [behindRaw, aheadRaw] = value.split(/\s+/);
  return {
    ahead: Number.parseInt(aheadRaw || '0', 10) || 0,
    behind: Number.parseInt(behindRaw || '0', 10) || 0,
  };
}

function detectConflicts(repoPath, remote, source, target) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-audit-'));
  const wtPath = path.join(tempRoot, 'worktree');

  try {
    const add = run('git', ['worktree', 'add', '--detach', wtPath, `${remote}/${target}`], repoPath);
    if (add.status !== 0) {
      return {
        hasConflict: true,
        conflictedFiles: ['<worktree-setup-failed>'],
        detail: add.stderr || add.stdout,
      };
    }

    const mergeAttempt = run('git', ['merge', '--no-commit', '--no-ff', `${remote}/${source}`], wtPath);
    if (mergeAttempt.status === 0) {
      run('git', ['merge', '--abort'], wtPath);
      return { hasConflict: false, conflictedFiles: [], detail: '' };
    }

    const conflicts = run('git', ['diff', '--name-only', '--diff-filter=U'], wtPath);
    const conflictedFiles = conflicts.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    run('git', ['merge', '--abort'], wtPath);

    return {
      hasConflict: true,
      conflictedFiles: conflictedFiles.length > 0 ? conflictedFiles : ['<unknown-conflict>'],
      detail: mergeAttempt.stderr || mergeAttempt.stdout,
    };
  } finally {
    run('git', ['worktree', 'remove', '--force', wtPath], repoPath);
    run('git', ['worktree', 'prune'], repoPath);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
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

function resolveReadiness({ ahead, conflict, ciStatus, allowPendingCi, allowFailedCi }) {
  if (ahead === 0) {
    return 'NO_CHANGES';
  }

  if (conflict.hasConflict) {
    return 'CONFLICT';
  }

  if (ciStatus === 'FAILED' && !allowFailedCi) {
    return 'BLOCKED_CI';
  }

  if ((ciStatus === 'PENDING' || ciStatus === 'UNKNOWN') && !allowPendingCi) {
    return 'BLOCKED_CI';
  }

  return 'READY';
}

function getReadinessReason({ readiness, ciStatus, ciReason, conflictDetail, allowPendingCi, allowFailedCi }) {
  if (readiness === 'READY') {
    return 'Stage is merge-ready under current policy.';
  }

  if (readiness === 'NO_CHANGES') {
    return 'No commits to promote for this stage transition.';
  }

  if (readiness === 'CONFLICT') {
    return `Merge conflict predicted during dry-run merge. ${conflictDetail || ''}`.trim();
  }

  if (readiness === 'BLOCKED_CI') {
    if (ciStatus === 'FAILED') {
      return allowFailedCi
        ? 'CI has failed, but failures are allowed by current override policy.'
        : `CI failed and promotion is blocked by policy. ${ciReason || ''}`.trim();
    }

    if (ciStatus === 'PENDING') {
      return allowPendingCi
        ? 'CI is pending, but pending checks are allowed by current override policy.'
        : `CI checks are pending and promotion is blocked by policy. ${ciReason || ''}`.trim();
    }

    return allowPendingCi
      ? 'CI status is unknown, but unknown status is allowed by current override policy.'
      : `CI status is unknown and promotion is blocked by policy. ${ciReason || ''}`.trim();
  }

  return 'Readiness state could not be classified.';
}

function getDiagnostics(repoPath) {
  const gitVersion = run('git', ['--version'], repoPath);
  const ghVersion = run('gh', ['--version'], repoPath);
  const ghAuth = run('gh', ['auth', 'status'], repoPath);

  return {
    api: { status: 'UP', message: 'Backend API process is running.' },
    git: {
      available: gitVersion.status === 0,
      output: gitVersion.stdout || gitVersion.stderr || 'git not found',
    },
    gh: {
      available: ghVersion.status === 0,
      version: ghVersion.stdout || ghVersion.stderr || 'gh not found',
      authenticated: ghAuth.status === 0,
      authOutput: ghAuth.stdout || ghAuth.stderr || 'No gh auth output',
    },
  };
}

function parseConfig(body) {
  const flow = Array.isArray(body.flow)
    ? body.flow.map((s) => String(s).trim()).filter(Boolean)
    : ['sandbox', 'feature', 'development', 'qa'];

  const repoContext = resolveRepoContext(body.repoPath || '.');

  return {
    repoInput: repoContext.repoInput,
    repoPath: repoContext.repoPath,
    repoInputType: repoContext.inputType,
    remote: body.remote ? String(body.remote).trim() : 'origin',
    from: body.from ? String(body.from).trim() : flow[0],
    to: body.to ? String(body.to).trim() : flow[flow.length - 1],
    flow,
    mode: body.mode === 'pr' ? 'pr' : 'direct',
    allowPendingCi: Boolean(body.allowPendingCi),
    allowFailedCi: Boolean(body.allowFailedCi),
  };
}

function auditTransitions(config) {
  ensureRepo(config.repoPath);
  git(config.repoPath, ['fetch', '--all', '--prune'], 'Fetch latest remote refs');

  const transitions = buildTransitions(config.flow, config.from, config.to);
  const branchList = getBranches(config.repoPath, config.remote);

  for (const t of transitions) {
    if (!branchList.includes(t.source)) {
      throw new Error(`Source branch missing: ${t.source}`);
    }
    if (!branchList.includes(t.target)) {
      throw new Error(`Target branch missing: ${t.target}`);
    }
  }

  const rows = transitions.map((transition) => {
    const aheadBehind = getAheadBehind(config.repoPath, config.remote, transition.source, transition.target);
    const ci = getCiStatus(config.repoPath, config.remote, transition.source);
    const conflict = detectConflicts(config.repoPath, config.remote, transition.source, transition.target);
    const readiness = resolveReadiness({
      ahead: aheadBehind.ahead,
      conflict,
      ciStatus: ci.status,
      allowPendingCi: config.allowPendingCi,
      allowFailedCi: config.allowFailedCi,
    });

    return {
      source: transition.source,
      target: transition.target,
      ahead: aheadBehind.ahead,
      behind: aheadBehind.behind,
      ciStatus: ci.status,
      ciReason: ci.reason,
      readiness,
      readinessReason: getReadinessReason({
        readiness,
        ciStatus: ci.status,
        ciReason: ci.reason,
        conflictDetail: conflict.detail,
        allowPendingCi: config.allowPendingCi,
        allowFailedCi: config.allowFailedCi,
      }),
      conflictedFiles: conflict.conflictedFiles,
      conflictDetail: conflict.detail,
    };
  });

  const blockedRows = rows.filter((row) => row.readiness === 'BLOCKED_CI' || row.readiness === 'CONFLICT');

  return {
    rows,
    blocked: blockedRows.length > 0,
    blockedRows,
  };
}

function doDirectMerge(config, source, target) {
  git(config.repoPath, ['fetch', '--all', '--prune'], 'Fetch before merge');
  git(config.repoPath, ['checkout', target], `Checkout ${target}`);
  git(config.repoPath, ['pull', config.remote, target], `Pull ${target}`);

  const merge = gitTry(config.repoPath, ['merge', '--no-ff', `${config.remote}/${source}`, '-m', `Promote ${source} -> ${target}`]);
  if (merge.status !== 0) {
    const conflictFiles = gitTry(config.repoPath, ['diff', '--name-only', '--diff-filter=U']).stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    gitTry(config.repoPath, ['merge', '--abort']);

    return {
      ok: false,
      reason: 'MERGE_CONFLICT',
      detail: merge.stderr || merge.stdout,
      conflictedFiles: conflictFiles,
    };
  }

  const head = git(config.repoPath, ['rev-parse', 'HEAD'], 'Resolve target head');
  const push = gitTry(config.repoPath, ['push', config.remote, target]);

  if (push.status !== 0) {
    return {
      ok: false,
      reason: 'PUSH_FAILED',
      detail: push.stderr || push.stdout,
      conflictedFiles: [],
    };
  }

  return {
    ok: true,
    commit: head,
    timestampUtc: new Date().toISOString(),
    detail: 'Merged and pushed successfully',
  };
}

function doPrMerge(config, source, target) {
  const repoSlug = getRepoSlug(config.repoPath, config.remote);
  if (!repoSlug) {
    return { ok: false, reason: 'REPO_SLUG_MISSING', detail: 'Unable to infer owner/repo from remote URL', conflictedFiles: [] };
  }

  if (run('gh', ['--version'], config.repoPath).status !== 0) {
    return { ok: false, reason: 'GH_MISSING', detail: 'GitHub CLI is required for PR mode', conflictedFiles: [] };
  }

  let prNumber = null;
  const list = run('gh', ['pr', 'list', '--repo', repoSlug, '--state', 'open', '--head', source, '--base', target, '--json', 'number'], config.repoPath);

  if (list.status === 0 && list.stdout) {
    try {
      const parsed = JSON.parse(list.stdout);
      if (Array.isArray(parsed) && parsed.length > 0) {
        prNumber = parsed[0].number;
      }
    } catch {
      prNumber = null;
    }
  }

  if (!prNumber) {
    const create = run('gh', [
      'pr', 'create',
      '--repo', repoSlug,
      '--base', target,
      '--head', source,
      '--title', `Promote ${source} -> ${target}`,
      '--body', `Automated promotion from ${source} to ${target}.`,
    ], config.repoPath);

    if (create.status !== 0) {
      return { ok: false, reason: 'PR_CREATE_FAILED', detail: create.stderr || create.stdout, conflictedFiles: [] };
    }

    const listAgain = run('gh', ['pr', 'list', '--repo', repoSlug, '--state', 'open', '--head', source, '--base', target, '--json', 'number'], config.repoPath);
    if (listAgain.status !== 0 || !listAgain.stdout) {
      return { ok: false, reason: 'PR_DISCOVERY_FAILED', detail: listAgain.stderr || listAgain.stdout, conflictedFiles: [] };
    }

    const parsed = JSON.parse(listAgain.stdout);
    prNumber = parsed?.[0]?.number || null;
  }

  if (!prNumber) {
    return { ok: false, reason: 'PR_NUMBER_MISSING', detail: 'Unable to resolve PR number', conflictedFiles: [] };
  }

  const merge = run('gh', ['pr', 'merge', String(prNumber), '--repo', repoSlug, '--merge'], config.repoPath);
  if (merge.status !== 0) {
    return { ok: false, reason: 'PR_MERGE_FAILED', detail: merge.stderr || merge.stdout, conflictedFiles: [] };
  }

  const head = git(config.repoPath, ['rev-parse', `${config.remote}/${target}`], 'Resolve target head after PR merge');
  return {
    ok: true,
    commit: head,
    timestampUtc: new Date().toISOString(),
    detail: `PR #${prNumber} merged`,
  };
}

function promoteTransitions(config, audit) {
  const working = getRepoStatus(config.repoPath);
  if (!working.isClean) {
    return {
      ok: false,
      finalStatus: 'PROMOTION_HALTED',
      reason: 'WORKTREE_DIRTY',
      detail: 'Working tree must be clean before execution.',
      changedFiles: working.changedFiles,
    };
  }

  if (audit.blocked) {
    return {
      ok: false,
      finalStatus: 'PROMOTION_HALTED',
      reason: 'PRECHECK_BLOCKED',
      detail: 'At least one stage is blocked by CI or conflicts.',
      blockedRows: audit.blockedRows,
    };
  }

  const executionLog = [];

  for (const row of audit.rows) {
    if (row.readiness === 'NO_CHANGES') {
      executionLog.push({
        transition: `${row.source} -> ${row.target}`,
        status: 'SKIPPED_NO_CHANGES',
      });
      continue;
    }

    const result = config.mode === 'pr'
      ? doPrMerge(config, row.source, row.target)
      : doDirectMerge(config, row.source, row.target);

    if (!result.ok) {
      return {
        ok: false,
        finalStatus: 'PROMOTION_HALTED',
        reason: result.reason,
        detail: result.detail,
        conflictedFiles: result.conflictedFiles || [],
        haltedAt: `${row.source} -> ${row.target}`,
        executionLog,
        remediation: [
          `git checkout ${row.target}`,
          `git pull ${config.remote} ${row.target}`,
          `git merge ${config.remote}/${row.source}`,
          '# Resolve conflicts in reported files',
          'git add <resolved-files>',
          'git commit',
          `git push ${config.remote} ${row.target}`,
        ],
      };
    }

    executionLog.push({
      transition: `${row.source} -> ${row.target}`,
      status: 'MERGED',
      commit: result.commit,
      timestampUtc: result.timestampUtc,
      detail: result.detail,
    });
  }

  return {
    ok: true,
    finalStatus: 'PROMOTION_COMPLETE',
    mode: config.mode,
    executionLog,
  };
}

async function handleRequest(req, res) {
  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {});
    return;
  }

  const url = new URL(req.url || '/', `http://${req.headers.host}`);

  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, service: 'git-api' });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/diagnostics') {
      const repoContext = resolveRepoContext(url.searchParams.get('repoPath') || '.');
      ensureRepo(repoContext.repoPath);

      sendJson(res, 200, {
        ok: true,
        repoInput: repoContext.repoInput,
        repoInputType: repoContext.inputType,
        repoPath: repoContext.repoPath,
        diagnostics: getDiagnostics(repoContext.repoPath),
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/repo') {
      const repoContext = resolveRepoContext(url.searchParams.get('repoPath') || '.');
      const repoPath = repoContext.repoPath;
      const remote = url.searchParams.get('remote') || 'origin';

      ensureRepo(repoPath);
      git(repoPath, ['fetch', '--all', '--prune'], 'Fetch remote refs');

      const status = getRepoStatus(repoPath);
      const branches = getBranches(repoPath, remote);
      const recentCommits = getRecentCommits(repoPath, 20);

      sendJson(res, 200, {
        ok: true,
        repoInput: repoContext.repoInput,
        repoInputType: repoContext.inputType,
        repoPath,
        remote,
        status,
        branches,
        recentCommits,
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/audit') {
      const body = await parseJsonBody(req);
      const config = parseConfig(body);

      const audit = auditTransitions(config);
      sendJson(res, 200, {
        ok: true,
        config,
        audit,
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/promote') {
      const body = await parseJsonBody(req);
      const config = parseConfig(body);

      const audit = auditTransitions(config);
      const promotion = promoteTransitions(config, audit);

      sendJson(res, promotion.ok ? 200 : 409, {
        ok: promotion.ok,
        config,
        audit,
        promotion,
      });
      return;
    }

    sendJson(res, 404, {
      ok: false,
      error: 'Not found',
    });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: error?.message || 'Unknown server error',
      details: error?.details || null,
    });
  }
}

const server = http.createServer((req, res) => {
  handleRequest(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`Git API server running at http://${HOST}:${PORT}`);
});
