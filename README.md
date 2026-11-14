# Repo Radar

A browser extension that gives a whole view of any GitHub repository in a side panel: how alive it is, how well it's kept, whether its dependencies are safe, and what its architecture looks like.

Open any repo on github.com, click the Repo Radar icon, and the panel scans it. You can also paste any `owner/repo` link into the panel.

## What it shows

| Tab | What you get | Where it comes from |
|---|---|---|
| **Overview** | A letter grade, a 0–100 score, a one-line verdict, a year of weekly commits, and a list of where points were lost | Computed from the tabs below |
| **Activity** | Commits and merged PRs in the last 90 days, open PRs and issues, issues idle 90+ days, typical time to merge a PR and close an issue, top contributors, bus factor | GitHub API |
| **Health** | Hygiene checklist (README, license, tests, CI configured and passing, contributing guide, security policy, templates) plus Repo Pilot's code-structure report card | GitHub API, Repo Pilot |
| **Dependencies** | Known vulnerabilities by severity, packages far behind their latest version, and packages under a GPL-family licence | Dependency files checked against [OSV.dev](https://osv.dev) and [deps.dev](https://deps.dev) |
| **Architecture** | The repo's real import graph as a zoomable, searchable diagram with clickable boxes, plus its most-imported files | Parsed in the browser from one download of the source. Repo Pilot optional |
| **Compare** | A second repo scanned and set beside the first, with the better value in each row highlighted | The same scan, run twice |

Every number and the verdict sentence are computed from data. No LLM decides the score, in the same spirit as Repo Pilot: structure is parsed, never generated.

**Bus factor** is the fewest people who together made half of the last year's commits. A bus factor of 1 means the project leans on one person.

**The overall score** weighs activity 35%, hygiene 25%, dependencies 20%, code structure 20%. Parts that aren't available (no manifests, Repo Pilot not connected) are left out and the rest re-weighted, never counted as zero. Outdated packages and licences are shown but do not change the score.

### Supported languages

| | Covered |
|---|---|
| **Dependency files** | npm (`package-lock.json`, `package.json`), PyPI (`requirements.txt`, `poetry.lock`, `pyproject.toml`), Go (`go.mod`), Rust (`Cargo.lock`, `Cargo.toml`), Java (`pom.xml`, `build.gradle`), Ruby (`Gemfile.lock`), PHP (`composer.lock`, `composer.json`) |
| **Import diagram** | JavaScript, TypeScript, Vue, Svelte, Python, Dart, Go, Java, Rust, C# |

### Sharing and watching

- **Copy report** puts the scan on the clipboard as Markdown, ready for an issue, a pull request or a chat.
- **Copy badge** gives a README badge with today's grade. It is a fixed picture drawn by shields.io and does not update itself.
- **Download SVG** saves the architecture diagram.
- **Watch** adds the repo to a watchlist. Watched repos are re-scanned once a day, and you get a notification when a grade drops or a new vulnerability appears. Without a GitHub token only the first 4 watched repos are checked.

## Install (developer mode)

```bash
npm install          # dev tools only; the extension has no runtime npm dependencies
npm run vendor       # copies Mermaid into vendor/ (already done in this repo)
```

**Chrome and Edge**

1. Open `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
2. Click **Load unpacked** and pick this folder.
3. Pin Repo Radar, open any GitHub repo, and click the icon.

**Firefox** (128 or newer)

```bash
npm run firefox      # writes build/firefox/ with a Firefox manifest
```

Open `about:debugging` → **This Firefox** → **Load Temporary Add-on** and pick `build/firefox/manifest.json`. The panel opens as a sidebar.

## Settings

Right-click the icon → **Options**, or use the ⚙ button in the panel.

- **GitHub token (optional).** One scan costs about 12 GitHub requests, so without a token you get roughly 5 scans an hour. A fine-grained token with public-repo read-only access raises that to about 400. It's kept in `chrome.storage.local` on your computer only.
- **Sign in with GitHub (off by default).** A one-click alternative to pasting a token. It appears once `CLIENT_ID` in `src/lib/oauth.js` is set to the client ID of a GitHub OAuth app that has **Enable Device Flow** ticked. No client secret is involved and no scope is requested, so the token can only read public data.
- **Repo Pilot backend URL (optional).** Adds the code-structure score and an alternative Repo Pilot diagram. The Architecture tab works without it. The browser asks permission for that one host when you save.
- **Endpoint paths (advanced).** Repo Radar calls Repo Pilot's HTTP API and never modifies it. Defaults are `/api/ingest`, `/api/diagram`, `/api/code-health`, `/api/onboarding` and `/api/ask`, each a `POST` with `{"repo_url": "..."}`. Edit them here if your Repo Pilot routes differ.

Scans are cached for 30 minutes per repo. **Refresh** on the Overview tab forces a new one.

## Project layout

```
manifest.json          Manifest V3: side panel, options page, service worker
src/background.js      opens the side panel on icon click; runs the daily watchlist check
src/lib/               pure logic, no chrome.* calls (easy to test)
  repoUrl.js           parse github.com links
  github.js            REST client: token, rate-limit errors, 202 retry for /stats
  collect.js           the ~12 requests a scan makes, in parallel, trimmed for caching
  score.js             activity, bus factor, hygiene, dependency, overall score, verdict, explanations
  deps.js              manifest parsing, OSV batch lookup, licence and latest version from deps.dev
  tarball.js           one .tar.gz download of the repo, gunzipped and untarred in memory
  graph.js             import parsing per language, Mermaid output, hub files
  watch.js             watchlist: what to remember and what counts as "got worse"
  oauth.js             GitHub device-flow sign-in
  repoPilot.js         read-only Repo Pilot client, tolerant of response shapes
  settings.js          chrome.storage wrapper
src/panel/             the side panel UI
src/options/           the settings page
scripts/firefox.js     builds the Firefox version
vendor/mermaid.min.js  bundled, because extensions can't load remote scripts
tests/                 unit tests + the real panel run in jsdom with fake chrome/fetch
```

## Tests

```bash
npm test
```

`tests/panel.test.js` loads the real `panel.html` and `panel.js` into jsdom with `chrome.*` and `fetch` faked, then clicks through every tab, including a Repo Pilot run.

## Limits

- GitHub only. Public repositories only (private repos return "not found" unless your token can read them).
- Versions read from ranges (`package.json`, `Cargo.toml`, `pyproject.toml`, `composer.json`) are the lowest allowed and may over-report; a lockfile is used whenever one exists. Lockfiles other than `package-lock.json` and `Gemfile.lock` also list indirect dependencies.
- Latest version and licence are looked up for the first 30 dependencies, and not for PHP packages.
- Typical merge and close times are medians over the 100 most recently updated closed pull requests and issues, not the whole history.
- GitHub computes `/stats` lazily. On a repo nobody has looked at recently, the commit strip and bus factor may be empty on the first scan; refresh after a minute.
- Very large repos get a truncated file tree from GitHub, so a few hygiene checks can read as missing. The panel says when this happens.
- In the diagram, Go and C# import whole packages and namespaces, so their arrows point at a folder box named `*`. Imports that go through custom path aliases or build config (other than `@/` and `~/` for `src/`), and Rust imports between crates of one workspace, are not resolved. Repos over 150 MB are skipped.

## Privacy

No server, no analytics, no tracking. See [PRIVACY.md](PRIVACY.md).

## Package for the Chrome Web Store

```bash
npm run zip          # builds repo-radar.zip from the last commit (commit your changes first)
```

## License

MIT. The bundled Mermaid library is MIT too, see `vendor/mermaid.LICENSE`.
