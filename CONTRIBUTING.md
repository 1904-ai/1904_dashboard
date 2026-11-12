# Contributing to 1904 Desktop

We welcome bug reports, documentation fixes, and changes to the desktop app. Read the [code of conduct](CODE_OF_CONDUCT.md) before participating.

## Report a bug or propose a change

Search [existing issues](https://github.com/1904-ai/1904_dashboard/issues) before opening a new one. For a bug, include your app version, operating system, and steps to reproduce it. If you can reproduce it in a regular browser at [1904 Agents](https://1904.ai/agents), mention that in the report. Use the [security policy](SECURITY.md) for vulnerabilities.

For a change that affects sign-in, notifications, updates, or packaging, open an issue first so maintainers can discuss how to test it across platforms.

## Develop and test

On Windows or macOS with Node.js 22.12 or later, run `npm ci` and `npm start` from your checkout. Development uses the live 1904 dashboard. Use an account and workspace you can safely test with. The [README](README.md#build-from-source) lists the preview build commands for each platform.

- Run `npm run check` before opening a pull request.
- For visible changes, exercise the affected flow in Electron and include a screenshot when it helps show the change. Note which platform and app build you used.
- For changes to links, sign-in, notifications, or updates, describe how you exercised the affected flow and which platforms you covered. Use [the release guide](RELEASING.md) for checks that need signed packages.

## Open a pull request

Fork the repo, branch from `main`, and open a pull request against `main`. Explain the problem, what changed, and how you verified it. Link a related issue if one exists. Commit changes to `package-lock.json` with dependency changes. Keep generated installers, signing material, and private account or workspace details out of commits and reports.
