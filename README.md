# 1904 Desktop

1904 Desktop brings the [1904 Agents dashboard](https://1904.ai/agents) to Windows and macOS. Open agent tasks, review changes, and get task notifications from an Electron app with a dedicated browser profile.

The app connects to the hosted 1904 service. You need a 1904 account and an internet connection to use the dashboard. The service manages accounts, agent workspaces, Git worktrees, conversations, and remote terminals.

The app is more than a browser window when you turn on [Use My Computer](#use-my-computer): a task’s agent can then ask to run commands on this computer, and each one runs only if you approve it here.

## Install

Check [GitHub Releases](https://github.com/1904-ai/1904/releases) for Windows x64, Apple Silicon, and Intel Mac downloads. You can also [build the app from source](#build-from-source).

## Sign in

Choose **1904 → Sign In with Browser**, sign in to 1904, then choose **Open 1904 Desktop** in the browser. You can also sign in directly with your email and password. For an email sign-in link, copy the link address and choose **1904 → Open Copied 1904 Link**. That menu action also accepts copied task links. From a task on the web, choose **Open in 1904 Desktop** in its menu.

The app needs internet access. Use **View → Reload** to reconnect after a failed load. The native notification settings for 1904 Desktop control dashboard notifications on this device.

The title bar follows the dashboard theme. Use **…** in the title bar to open the application menu. The app restores its window size and position. The overview scrolls within the task list or status board, and F6 and Shift+F6 move focus between workspace panes.

Open **… → Help** for the installed version, release notes, documentation, and support. Signed builds with an update feed show **Restart to Update** in Help when an update is ready.

## Use My Computer

A task’s agent works in the cloud. When a step can only happen on your machine, such as checking a tool’s version or running a local build, the agent can ask to run a shell command on this computer. 1904 Desktop asks you first. If you approve, it runs the command, shows it in **Computer Activity** as it runs, and sends its output and exit code back to the task.

**It is off until you connect this computer.** Choose **1904 → Use My Computer…** and confirm the prompt, which names this computer after its host name. You must be signed in to 1904 in the app. Until you connect, 1904 Desktop does not ask 1904 for commands, and nothing can run.

**Every command is approved on this computer.** A native prompt shows the task, who asked, the full command, the folder it starts in, and the reason the agent gave. Each line of the command starts with `│`, hidden or direction-changing characters are spelled out as `<U+…>`, and any character that is not plain ASCII is named with its code point, so a look-alike letter stands out. A command too long to show in full in one prompt (over 3,000 characters or 60 lines) is never asked about and never runs; the task is told to put it in a script file instead. **Decline** is the default. **Run once** runs this command. **Allow for this message** runs this command and later commands from the same message that start in the app’s folder. That allowance stays in memory, ends as soon as the task moves on to another message, and never lasts more than 30 minutes. A command that starts outside the app’s folder always asks, shows the full path, and can only be run once. Settings on 1904, including full access for a task, never approve a command on your computer. When the app is in the background, a notification tells you a prompt is waiting. An approved command starts only after 1904 confirms the request still stands.

**An approved command runs as you.** It runs as the user signed in to this computer, with your permissions, your environment, and access to your files and network, like a command you type yourself. Approve only commands you understand.

- On macOS, commands run in your login shell (`$SHELL -l -c`, or `/bin/zsh` when `$SHELL` is not set).
- On Windows, commands run in PowerShell 7 (`pwsh.exe`) when it is on your `PATH`, otherwise in Windows PowerShell, without loading your PowerShell profile.
- Input is closed, so a command that waits for input ends. Each command has a time limit set by the request, between 5 seconds and 30 minutes, 2 minutes by default. A command that runs past it is stopped along with everything it started. **Stop** in Computer Activity does the same.
- On macOS, anything a command leaves running in the background (`job &`) is stopped when the command ends. On Windows, a process a command starts in the background, for example with `Start-Process`, can keep running after the command ends, because Windows gives no way to find it once its parent has exited. A time limit or **Stop** reached while the command is still running does stop it.
- The last 48 KB of output and 16 KB of errors go back to the task, together with the exit code, the folder, and how long the command took. 1904 keeps the command text in your workspace’s audit log, so keep passwords and keys out of commands.

**Where commands start.** Each app gets its own folder, `~/1904/<app>` on macOS and `%USERPROFILE%\1904\<app>` on Windows, created the first time a command for that app runs. It starts empty, because the code lives in 1904. To use another folder, such as an existing checkout, choose **Choose folder…** in the prompt, or **Change…** under App folders in **1904 → Computer Activity**. **Reset** goes back to the default.

**Where the token is kept.** When you connect, 1904 issues a token for this computer. 1904 Desktop keeps it in `computer-link.json` in its data folder (`~/Library/Application Support/1904 Desktop` on macOS, `%APPDATA%\1904 Desktop` on Windows), encrypted with your system’s key store through Electron’s `safeStorage`: the Keychain on macOS and DPAPI on Windows. If that storage is not available, the computer is not connected. Only the app’s main process reads the token. The dashboard page can ask whether this computer is connected and start the connect prompt, and nothing else: it cannot run or approve a command, read output, or read the token.

**How to disconnect.** Choose **1904 → Use My Computer → Disconnect This Computer…**. Running commands stop, waiting prompts close, 1904 is asked to revoke the token, and the token is deleted from this computer, even when 1904 can’t be reached. To cut off a computer you no longer have, disconnect it under Computers in 1904 Settings; 1904 Desktop on that computer stops as soon as 1904 refuses its token.

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
