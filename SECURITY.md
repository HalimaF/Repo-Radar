# Security Policy

## Supported versions

Only the latest version on the `master` branch gets security fixes.

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through GitHub: open the repository's **Security** tab and click **Report a vulnerability**. Include what you found, how to reproduce it, and what an attacker could do with it.

You should get a reply within 7 days. Once a fix is released, the report is disclosed and you are credited unless you ask not to be.

## What matters most here

Repo Radar is a Chrome extension that reads public GitHub data and can store an optional GitHub token in `chrome.storage.local`. Reports of these are especially useful:

- Anything that leaks the stored GitHub token, or sends it to a host other than `api.github.com`.
- Content from a scanned repository (file names, README text, diagram labels) running as script in the side panel.
- The extension requesting or using more permissions than it needs.
