# Git Helper - Pipeline Merge Dashboard

Git Helper is a web UI plus API service for branch promotion workflows such as sandbox -> feature -> development -> qa.

## Deployable Architecture

The default backend now uses GitHub REST APIs and does not rely on local git or gh binaries.

Frontend:
- Static Vite React app

Backend:
- Node.js API at server/github-api.mjs

## Required Environment Variable

- GITHUB_TOKEN

Use a token that has permissions required for your repositories and merge actions.

Note:
- You can also provide a temporary token from the UI field. It is sent as `X-GitHub-Token` per request.
- For production, prefer server-side `GITHUB_TOKEN` or GitHub App auth instead of user-entered tokens.

Typical permissions:
- repo
- workflow (if check or workflow data access is needed)

## Local Development

1. Start backend:

```bash
npm run api
```

2. Start frontend:

```bash
npm run dev
```

3. In the UI, set repository as either:
- https://github.com/owner/repo
- owner/repo

## API Modes

Primary deployable mode:

```bash
npm run api
```

Legacy local-command mode (uses git/gh binaries):

```bash
npm run api:legacy
```
