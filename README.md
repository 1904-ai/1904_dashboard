# 1904 Desktop

1904 Desktop brings the [1904 Agents dashboard](https://1904.ai/agents) to Windows and macOS. Open agent tasks, review changes, and get task notifications from an Electron app with a dedicated browser profile.

The app connects to the hosted 1904 service. You need a 1904 account and an internet connection to use the dashboard. The service manages accounts, agent workspaces, Git worktrees, conversations, and remote terminals.

## Install

Check [GitHub Releases](https://github.com/1904-ai/1904/releases) for Windows x64, Apple Silicon, and Intel Mac downloads. You can also [build the app from source](#build-from-source).

## Sign in

Choose **1904 → Sign In with Browser**, sign in to 1904, then choose **Open 1904 Desktop** in the browser. You can also sign in directly with your email and password. For an email sign-in link, copy the link address and choose **1904 → Open Copied 1904 Link**. That menu action also accepts copied task links. From a task on the web, choose **Open in 1904 Desktop** in its menu.

The app needs internet access. Use **View → Reload** to reconnect after a failed load. The native notification settings for 1904 Desktop control dashboard notifications on this device.

The title bar follows the dashboard theme. Use **…** in the title bar to open the application menu. The app restores its window size and position. The overview scrolls within the task list or status board, and F6 and Shift+F6 move focus between workspace panes.

Use **Help → About 1904 Desktop** to see the installed version and **Help → What’s New** for release notes. Signed builds with an update feed show **Restart to Update** in Help when an update is ready.

## Build from source

Install Node.js 22.12 or later, then run these commands in a terminal on Windows or macOS.

```sh
git clone https://github.com/1904-ai/1904.git
cd 1904
npm ci
npm run check
npm start
```

| Host | Command | Output |
| --- | --- | --- |
| Windows | `npm run build:windows` | Windows x64 installer in `dist/` |
| macOS | `npm run build:mac` | macOS disk images for Apple Silicon and Intel in `dist/` |

The build commands produce preview packages. See the [release guide](RELEASING.md) for signing, update hosting, and rollout, and the [changelog](CHANGELOG.md) for version history.

## Get help and contribute

- For account or hosted dashboard help, contact [1904 Support](https://1904.ai/contact).
- For a desktop bug or feature request, open a [GitHub issue](https://github.com/1904-ai/1904/issues/new/choose).
- For a vulnerability, follow the [security policy](SECURITY.md) to report it privately.
- To submit a change, read the [contributing guide](CONTRIBUTING.md) and [code of conduct](CODE_OF_CONDUCT.md).

## License

1904 Desktop source is available under the [MIT license](LICENSE).
