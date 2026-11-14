# Privacy Policy

Repo Radar has no server of its own, no analytics and no tracking. Nothing is sent to the author.

## What stays on your computer

- **GitHub token (optional)**, your settings and your watchlist, in `chrome.storage.local`. The token is sent only to `api.github.com`, as the `Authorization` header.
- **Scan results**, cached in memory for 30 minutes and cleared when the browser closes.

## What leaves your computer

When you scan a repository, the extension requests data about that repository from:

| Service | What it receives |
|---|---|
| `api.github.com`, `raw.githubusercontent.com`, `codeload.github.com` | The owner and name of the repo you scan (and your token, on `api.github.com` only) |
| `api.osv.dev` | Names and versions of that repo's dependencies, to look up known vulnerabilities |
| `api.deps.dev` | Names and versions of up to 30 of those dependencies, to look up their licence and latest version |
| `github.com`, only if you use "Sign in with GitHub" | The sign-in request that GitHub answers with a token |
| `img.shields.io`, only if you paste a copied badge somewhere | Nothing from the extension. Whoever views the badge loads a picture that contains the grade letter |

Repos on your watchlist are scanned again once a day in the background, with the same requests as above.

## What it can see in the browser

Repo Radar reads the address of tabs on `github.com` only, to know which repository you are looking at. It does not read page content and cannot see tabs on other sites. It can show notifications, used only for watchlist changes.

## Contact

Open an issue on the project's GitHub repository.
