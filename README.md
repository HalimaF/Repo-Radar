# Repo Radar

A Chrome extension that gives a whole view of any GitHub repository in a side panel: how alive it is, how well it's kept, whether its dependencies are safe, and what its architecture looks like.

Open any repo on github.com, click the Repo Radar icon, and the panel scans it. You can also paste any `owner/repo` link into the panel.

## What it shows

| Tab | What you get | Where it comes from |
|---|---|---|
| **Overview** | A letter grade, a 0–100 score, a one-line verdict, and a year of weekly commits as a signal strip | Computed from the tabs below |
| **Activity** | Commits and merged PRs in the last 90 days, open PRs and issues, issues idle 90+ days, top contributors, bus factor | GitHub API |
| **Health** | Hygiene checklist (README, license, tests, CI configured and passing, contributing guide, security policy, templates) plus Repo Pilot's code-structure report card | GitHub API, Repo Pilot |
| **Dependencies** | Known vulnerabilities in direct dependencies, by severity, linked to OSV | `package-lock.json` / `package.json`, `requirements.txt`, `go.mod` checked against [OSV.dev](https://osv.dev) |
| **Architecture** | The repo's real import graph as a zoomable diagram, plus its most-imported files | Parsed in the browser from one download of the source (JS/TS, Vue, Svelte, Python, Dart). Repo Pilot optional |

Every number and the verdict sentence are computed from data. No LLM decides the score, in the same spirit as Repo Pilot: structure is parsed, never generated.

**Bus factor** is the fewest people who together made half of the last year's commits. A bus factor of 1 means the project leans on one person.

**The overall score** weighs activity 35%, hygiene 25%, dependencies 20%, code structure 20%. Parts that aren't available (no manifests, Repo Pilot not connected) are left out and the rest re-weighted, never counted as zero.

## Install (developer mode)

```bash
npm install          # dev tools only; the extension has no runtime npm dependencies
npm run vendor       # copies Mermaid into vendor/ (already done in this repo)
```

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this folder.
3. Pin Repo Radar, open any GitHub repo, and click the icon.

## Settings

Right-click the icon → **Options**, or use the ⚙ button in the panel.

- **GitHub token (optional).** One scan costs about 11 GitHub requests, so without a token you get roughly 5 scans an hour. A fine-grained token with public-repo read-only access raises that to about 450. It's kept in `chrome.storage.local` on your computer only.
- **Repo Pilot backend URL (optional).** Adds the code-structure score and an alternative Repo Pilot diagram. The Architecture tab works without it. Chrome asks permission for that one host when you save.
- **Endpoint paths (advanced).** Repo Radar calls Repo Pilot's HTTP API and never modifies it. Defaults are `/api/ingest`, `/api/diagram`, `/api/code-health`, `/api/onboarding` and `/api/ask`, each a `POST` with `{"repo_url": "..."}`. Edit them here if your Repo Pilot routes differ.

Scans are cached for 30 minutes per repo. **Refresh** on the Overview tab forces a new one.

## Project layout

```
manifest.json          Manifest V3: side panel, options page, service worker
src/background.js      opens the side panel on icon click
src/lib/               pure logic, no chrome.* calls (easy to test)
  repoUrl.js           parse github.com links
  github.js            REST client: token, rate-limit errors, 202 retry for /stats
  collect.js           the ~11 requests a scan makes, in parallel, trimmed for caching
  score.js             activity, bus factor, hygiene, dependency, overall score, verdict
  deps.js              manifest parsing + OSV batch lookup, de-duplicated by alias
  tarball.js           one .tar.gz download of the repo, gunzipped and untarred in memory
  graph.js             import parsing (JS/TS, Python, Dart), Mermaid output, hub files
  repoPilot.js         read-only Repo Pilot client, tolerant of response shapes
  settings.js          chrome.storage wrapper
src/panel/             the side panel UI
src/options/           the settings page
vendor/mermaid.min.js  bundled, because extensions can't load remote scripts
tests/                 unit tests + the real panel run in jsdom with fake chrome/fetch
```

## Tests

```bash
npm test
```

`tests/panel.test.js` loads the real `panel.html` and `panel.js` into jsdom with `chrome.*` and `fetch` faked, then clicks through every tab, including a Repo Pilot run.

## Limits

- Public repositories only (private repos return "not found" unless your token can read them).
- Dependency scanning covers npm, PyPI (`requirements.txt` pins) and Go. Versions read from `package.json` ranges are the lowest allowed and may over-report; a lockfile is used whenever one exists.
- GitHub computes `/stats` lazily. On a repo nobody has looked at recently, the commit strip and bus factor may be empty on the first scan; refresh after a minute.
- Very large repos get a truncated file tree from GitHub, so a few hygiene checks can read as missing. The panel says when this happens.

- The built-in diagram parses JS/TS (including Vue and Svelte), Python and Dart. Imports that go through custom path aliases or build config (other than `@/` and `~/` for `src/`) are not resolved. Repos over 150 MB are skipped.

## License

MIT
