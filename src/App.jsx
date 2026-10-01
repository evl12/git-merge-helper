import { useMemo, useState } from 'react';
import './App.css';

const defaultFlow = 'sandbox,feature,development,qa';

function parseFlow(flowText) {
  return flowText
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function formatDate(iso) {
  if (!iso) {
    return '-';
  }

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }

  return date.toLocaleString();
}

async function readApiResponse(response) {
  const text = await response.text();

  if (!text) {
    const err = new Error('API returned an empty response. Ensure backend is running with: npm run api');
    err.status = response.status;
    throw err;
  }

  try {
    return JSON.parse(text);
  } catch {
    const contentType = response.headers.get('content-type') || 'unknown';
    const snippet = text.slice(0, 180);
    const err = new Error(`API returned non-JSON response (status ${response.status}, content-type ${contentType}). ${snippet}`);
    err.status = response.status;
    throw err;
  }
}

function App() {
  const [repoPath, setRepoPath] = useState('.');
  const [remote, setRemote] = useState('origin');
  const [githubToken, setGithubToken] = useState('');
  const [mode, setMode] = useState('direct');
  const [deepMergeCheck, setDeepMergeCheck] = useState(false);
  const [flowText, setFlowText] = useState(defaultFlow);
  const [fromBranch, setFromBranch] = useState('sandbox');
  const [toBranch, setToBranch] = useState('qa');
  const [allowPendingCi, setAllowPendingCi] = useState(false);
  const [allowFailedCi, setAllowFailedCi] = useState(false);

  const [repoData, setRepoData] = useState(null);
  const [auditData, setAuditData] = useState(null);
  const [promotionData, setPromotionData] = useState(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [isLoadingRepo, setIsLoadingRepo] = useState(false);
  const [isAuditing, setIsAuditing] = useState(false);
  const [isPromoting, setIsPromoting] = useState(false);
  const [apiHealth, setApiHealth] = useState('unknown');
  const [diagnostics, setDiagnostics] = useState(null);
  const [isRunningDiagnostics, setIsRunningDiagnostics] = useState(false);

  const flow = useMemo(() => parseFlow(flowText), [flowText]);

  const canAudit = flow.length >= 2 && fromBranch && toBranch;

  const payload = {
    repoPath,
    remote,
    mode,
    deepMergeCheck,
    flow,
    from: fromBranch,
    to: toBranch,
    allowPendingCi,
    allowFailedCi,
  };

  function buildAuthHeaders(extra = {}) {
    const headers = { ...extra };
    if (githubToken.trim()) {
      headers['X-GitHub-Token'] = githubToken.trim();
    }
    return headers;
  }

  async function checkApiHealth() {
    try {
      const response = await fetch('/api/health');
      const data = await readApiResponse(response);
      if (!response.ok || !data.ok) {
        setApiHealth('down');
        return false;
      }
      setApiHealth('up');
      return true;
    } catch {
      setApiHealth('down');
      return false;
    }
  }

  async function loadRepo() {
    setErrorMessage('');
    setIsLoadingRepo(true);
    setAuditData(null);
    setPromotionData(null);

    try {
      const healthy = await checkApiHealth();
      if (!healthy) {
        throw new Error('Backend API is not reachable. Start it with: npm run api');
      }

      const params = new URLSearchParams({ repoPath, remote });
      const response = await fetch(`/api/repo?${params.toString()}`, {
        headers: buildAuthHeaders(),
      });
      const data = await readApiResponse(response);

      if (!response.ok || !data.ok) {
        throw new Error(data.error || 'Failed to load repository data');
      }

      setRepoData(data);

      if (data.branches?.length > 0) {
        if (!data.branches.includes(fromBranch)) {
          setFromBranch(data.branches[0]);
        }
        if (!data.branches.includes(toBranch)) {
          setToBranch(data.branches[data.branches.length - 1]);
        }
      }
    } catch (error) {
      setErrorMessage(error.message || 'Failed to load repository');
    } finally {
      setIsLoadingRepo(false);
    }
  }

  async function runDiagnostics() {
    setErrorMessage('');
    setIsRunningDiagnostics(true);

    try {
      const params = new URLSearchParams({ repoPath });
      const response = await fetch(`/api/diagnostics?${params.toString()}`, {
        headers: buildAuthHeaders(),
      });
      const data = await readApiResponse(response);

      if (!response.ok || !data.ok) {
        throw new Error(data.error || 'Diagnostics failed');
      }

      setDiagnostics(data);
      setApiHealth('up');
    } catch (error) {
      setApiHealth('down');
      setDiagnostics(null);
      setErrorMessage(error.message || 'Diagnostics failed');
    } finally {
      setIsRunningDiagnostics(false);
    }
  }

  async function runAudit() {
    setErrorMessage('');
    setIsAuditing(true);
    setPromotionData(null);

    try {
      const healthy = await checkApiHealth();
      if (!healthy) {
        throw new Error('Backend API is not reachable. Start it with: npm run api');
      }

      const response = await fetch('/api/audit', {
        method: 'POST',
        headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload),
      });

      const data = await readApiResponse(response);
      if (!response.ok || !data.ok) {
        throw new Error(data.error || 'Audit failed');
      }

      setAuditData(data);
    } catch (error) {
      setErrorMessage(error.message || 'Audit failed');
    } finally {
      setIsAuditing(false);
    }
  }

  async function runPromotion() {
    setErrorMessage('');
    setIsPromoting(true);

    try {
      const healthy = await checkApiHealth();
      if (!healthy) {
        throw new Error('Backend API is not reachable. Start it with: npm run api');
      }

      const response = await fetch('/api/promote', {
        method: 'POST',
        headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload),
      });

      const data = await readApiResponse(response);

      if (!data.ok) {
        setPromotionData(data);
        throw new Error(data.error || data.promotion?.detail || 'Promotion halted');
      }

      setPromotionData(data);
    } catch (error) {
      setErrorMessage(error.message || 'Promotion failed');
    } finally {
      setIsPromoting(false);
    }
  }

  const auditRows = auditData?.audit?.rows || [];
  const blocked = Boolean(auditData?.audit?.blocked);
  const executionLog = promotionData?.promotion?.executionLog || [];

  return (
    <main className="page">
      <header className="hero">
        <p className="kicker">Git Helper</p>
        <h1>Pipeline Merge Control Center</h1>
        <p className="subtitle">
          Track repository health, review recent changes and authors, run mergeability audits,
          and execute branch promotions from a single interface.
        </p>
      </header>

      <section className="panel config-grid">
        <label>
          Repository Path
          <input
            value={repoPath}
            onChange={(e) => setRepoPath(e.target.value)}
            placeholder="d:/path/to/repo or https://github.com/owner/repo"
          />
        </label>

        <label>
          Remote
          <input value={remote} onChange={(e) => setRemote(e.target.value)} placeholder="origin" />
        </label>

        <label>
          GitHub Token (optional override)
          <input
            type="password"
            value={githubToken}
            onChange={(e) => setGithubToken(e.target.value)}
            placeholder="ghp_..."
          />
        </label>

        <label>
          Promotion Mode
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="direct">Direct Merge</option>
            <option value="pr">PR Merge (GitHub CLI)</option>
          </select>
        </label>

        <label>
          Branch Flow (comma separated)
          <input value={flowText} onChange={(e) => setFlowText(e.target.value)} placeholder="sandbox,feature,development,qa" />
        </label>

        <label>
          From Branch
          <select value={fromBranch} onChange={(e) => setFromBranch(e.target.value)}>
            {flow.map((branch) => (
              <option key={branch} value={branch}>
                {branch}
              </option>
            ))}
            {repoData?.branches?.map((branch) => (
              <option key={`repo-${branch}`} value={branch}>
                {branch}
              </option>
            ))}
          </select>
        </label>

        <label>
          To Branch
          <select value={toBranch} onChange={(e) => setToBranch(e.target.value)}>
            {flow.map((branch) => (
              <option key={`to-${branch}`} value={branch}>
                {branch}
              </option>
            ))}
            {repoData?.branches?.map((branch) => (
              <option key={`to-repo-${branch}`} value={branch}>
                {branch}
              </option>
            ))}
          </select>
        </label>

        <div className="toggles">
          <label className="checkbox">
            <input type="checkbox" checked={allowPendingCi} onChange={(e) => setAllowPendingCi(e.target.checked)} />
            Allow Pending or Unknown CI
          </label>

          <label className="checkbox">
            <input type="checkbox" checked={allowFailedCi} onChange={(e) => setAllowFailedCi(e.target.checked)} />
            Allow Failed CI
          </label>

          <label className="checkbox">
            <input type="checkbox" checked={deepMergeCheck} onChange={(e) => setDeepMergeCheck(e.target.checked)} />
            Deep Merge Check (may create temporary audit PR)
          </label>
        </div>

        <div className="actions">
          <button type="button" onClick={loadRepo} disabled={isLoadingRepo}>
            {isLoadingRepo ? 'Loading...' : 'Load Repo Status'}
          </button>

          <button type="button" onClick={runAudit} disabled={isAuditing || !canAudit}>
            {isAuditing ? 'Checking...' : 'Check Mergeability'}
          </button>

          <button type="button" onClick={runPromotion} disabled={isPromoting || !canAudit} className="primary">
            {isPromoting ? 'Promoting...' : 'Run Auto Promotion'}
          </button>

          <button type="button" onClick={runDiagnostics} disabled={isRunningDiagnostics}>
            {isRunningDiagnostics ? 'Diagnosing...' : 'Run Environment Diagnostics'}
          </button>
        </div>
      </section>

      <section className="panel health-panel">
        <h2>Backend Connectivity</h2>
        <p>
          API Status:{' '}
          <strong className={apiHealth === 'up' ? 'ok' : apiHealth === 'down' ? 'warn' : ''}>
            {apiHealth === 'unknown' ? 'Not checked yet' : apiHealth === 'up' ? 'Online' : 'Offline'}
          </strong>
        </p>
        <p className="hint">
          Public GitHub repositories do not require credentials for clone and fetch. GitHub credentials are needed only
          for private repositories, CI check APIs, or PR merge mode via gh auth.
        </p>
        {diagnostics?.diagnostics ? (
          <div className="diag-box">
            <p>
              GitHub API: <strong>{diagnostics.diagnostics.api?.status || 'UNKNOWN'}</strong>
            </p>
            <p>
              Token Configured: <strong>{diagnostics.diagnostics.githubToken?.configured ? 'Yes' : 'No'}</strong>
            </p>
            <p>
              Token Source: <strong>{diagnostics.diagnostics.githubToken?.source || 'none'}</strong>
            </p>
            <p>
              Repo Access: <strong>{diagnostics.diagnostics.repoAccess?.ok ? 'OK' : 'Unavailable'}</strong>
            </p>
            <p>
              Auth Actor: <strong>{diagnostics.diagnostics.authActor?.login || '-'}</strong>
            </p>
            <p>
              Repo Write Permission: <strong>{diagnostics.diagnostics.repoAccess?.permissions?.push ? 'Yes' : 'No'}</strong>
            </p>
            <p>
              Allowed Merge Methods:{' '}
              <strong>
                {(diagnostics.diagnostics.repoAccess?.allowedMergeMethods || []).length > 0
                  ? diagnostics.diagnostics.repoAccess.allowedMergeMethods.join(', ')
                  : '-'}
              </strong>
            </p>
            <p className="hint">{diagnostics.diagnostics.api?.message || '-'}</p>
            <p className="hint">{diagnostics.diagnostics.repoAccess?.message || ''}</p>
            <p className="hint">{diagnostics.diagnostics.authActor?.error || ''}</p>
          </div>
        ) : null}
      </section>

      {errorMessage ? <p className="error">{errorMessage}</p> : null}

      <section className="panel status-grid">
        <article>
          <h2>Repository Status</h2>
          <p>
            Current Branch: <strong>{repoData?.status?.currentBranch || '-'}</strong>
          </p>
          <p>
            Working Tree: <strong>{repoData?.status?.isClean ? 'Clean' : 'Has Local Changes'}</strong>
          </p>
          <p>
            Remote: <strong>{repoData?.remote || remote}</strong>
          </p>
          <p>
            Input Type: <strong>{repoData?.repoInputType || '-'}</strong>
          </p>
          <p>
            Resolved Repo: <strong>{repoData?.repoPath || '-'}</strong>
          </p>
        </article>

        <article>
          <h2>Local Change List</h2>
          <ul className="changed-files">
            {(repoData?.status?.changedFiles || []).length === 0 ? (
              <li>No local file changes.</li>
            ) : (
              (repoData?.status?.changedFiles || []).map((file) => <li key={file}>{file}</li>)
            )}
          </ul>
        </article>
      </section>

      <section className="panel">
        <h2>Recent Commits and Authors</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Commit</th>
                <th>Author</th>
                <th>Date</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {(repoData?.recentCommits || []).length === 0 ? (
                <tr>
                  <td colSpan={4}>Load repository status to view recent changes.</td>
                </tr>
              ) : (
                (repoData?.recentCommits || []).map((commit) => (
                  <tr key={commit.sha}>
                    <td>{commit.shortSha}</td>
                    <td>{commit.authorName}</td>
                    <td>{formatDate(commit.date)}</td>
                    <td>{commit.subject}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <h2>Mergeability Audit</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Stage Transition</th>
                <th>Ahead/Behind</th>
                <th>CI Status</th>
                <th>Readiness</th>
                <th>Conflicted Files</th>
              </tr>
            </thead>
            <tbody>
              {auditRows.length === 0 ? (
                <tr>
                  <td colSpan={5}>Run mergeability check to view audit rows.</td>
                </tr>
              ) : (
                auditRows.map((row) => (
                  <tr key={`${row.source}-${row.target}`}>
                    <td>{row.source} -&gt; {row.target}</td>
                    <td>+{row.ahead} / -{row.behind}</td>
                    <td>{row.ciStatus}</td>
                    <td>
                      <span className={`badge ${row.readiness.toLowerCase()}`}>{row.readiness}</span>
                      <div className="cell-note">{row.readinessReason || row.ciReason || ''}</div>
                    </td>
                    <td>{row.conflictedFiles.length > 0 ? row.conflictedFiles.join(', ') : 'None'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {auditRows.length > 0 ? (
          <p className={blocked ? 'warn' : 'ok'}>
            {blocked
              ? 'Promotion is blocked because at least one stage has either unresolved conflicts or CI policy blocks (failed, pending, or unknown checks). Check the Readiness details in the table.'
              : 'All selected transitions are mergeable under current policy.'}
          </p>
        ) : null}
      </section>

      <section className="panel">
        <h2>Promotion Execution Log</h2>
        <ul className="execution-log">
          {executionLog.length === 0 ? (
            <li>No promotion run yet.</li>
          ) : (
            executionLog.map((entry, idx) => (
              <li key={`${entry.transition}-${idx}`}>
                <strong>{entry.transition}</strong> - {entry.status}
                {entry.commit ? ` (${entry.commit.slice(0, 8)})` : ''}
                {entry.timestampUtc ? ` at ${formatDate(entry.timestampUtc)}` : ''}
              </li>
            ))
          )}
        </ul>
        {promotionData?.promotion?.finalStatus ? (
          <p className={promotionData?.promotion?.finalStatus === 'PROMOTION_COMPLETE' ? 'ok' : 'warn'}>
            Final Status: {promotionData.promotion.finalStatus}
          </p>
        ) : null}
        {promotionData?.promotion?.reason ? (
          <p className="warn">
            Halt Reason: {promotionData.promotion.reason}
          </p>
        ) : null}
        {promotionData?.promotion?.detail ? (
          <p className="warn">
            Detail: {promotionData.promotion.detail}
          </p>
        ) : null}
        {promotionData?.promotion?.haltedAt ? (
          <p className="warn">
            Halted At: {promotionData.promotion.haltedAt}
          </p>
        ) : null}
      </section>
    </main>
  );
}

export default App;
