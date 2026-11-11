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

Every protection below is enforced by 1904 Desktop on this computer, so it holds even if the cloud side (an agent, its runtime, or 1904’s own servers) is compromised.

**It is off until you connect this computer.** Choose **1904 → Use My Computer…** and confirm the prompt, which names this computer after its host name. You must be signed in to 1904 in the app. Until you connect, 1904 Desktop does not ask 1904 for commands, and nothing can run.

**Only your own messages from this window.** When you send a message from 1904 Desktop, the app adds a proof to it that only this computer can make, and remembers the message for six hours. It does so only if you pressed a key or clicked in the window within the previous 10 seconds and the window is in front, so a script on the page cannot send a message as you while you are away from it; a message without that leaves unstamped and is noted in this computer’s log. 1904 lets a task use this computer only for such a message, and 1904 Desktop checks the message against its own list before it asks you anything. A request for a message sent from a browser or a phone is refused without a prompt, unless you started away mode for that task here (below).

**Every command is approved on this computer.** A native prompt shows the task, who asked, the full command, the folder it starts in, and the reason the agent gave. Each line of the command starts with `│`, hidden or direction-changing characters are spelled out as `<U+…>`, and any character that is not plain ASCII is named with its code point, so a look-alike letter stands out. A command too long to show in full in one prompt (over 3,000 characters or 60 lines) is never asked about and never runs; the task is told to put it in a script file instead. **Decline** is the default. **Run once** runs this command. **Allow for this message** runs this command and later sandboxed commands from the same message that start in the app’s folder. That allowance stays in memory, ends as soon as the task moves on to another message, and never lasts more than 30 minutes. A command that starts outside the app’s folder always asks, shows the full path, and can only be run once. Settings on 1904, including full access for a task, never approve a command on your computer. When the app is in the background, a notification tells you a prompt is waiting. An approved command starts only after 1904 confirms the request still stands.

**Commands run in a sandbox on macOS.** Unless you approve full access, a command runs under macOS’s `sandbox-exec` with a profile 1904 Desktop writes for that one run. The profile denies everything, then allows only what command-line tools need:

- it can run and fork programs, signal only its own processes, read hardware and system facts by name, and use a short named list of system services (logging, user lookups, notifications, preference reads);
- it can read the system, but not your home folder, other drives (`/Volumes`) or other apps’ temporary files. It can read the app’s folder, its own temporary folder, and toolchains: git’s own settings (not its credentials), and the runtimes and download caches of nvm, npm, Bun, Volta, Deno, asdf, pyenv, rbenv, rustup, Cargo, Go, pipx and uv, pnpm, Gradle and Maven caches, CocoaPods and SDKMAN;
- it can change files only in the app’s folder and in a temporary folder of its own, which is deleted afterwards. Even in the app’s folder it cannot create, change or replace what other tools later run outside the sandbox: `.git` itself, git’s settings, hooks and attributes (also in submodules), `.vscode`, `.idea`, `.zed`, `.cursor` and `.husky` folders, `.envrc` and `.pre-commit-config.yaml`. That also means it cannot `git init` or `git clone` into the folder; run that with full access;
- your credential stores (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.config/gcloud`, `~/.kube`, `~/.docker`, `~/.codex`, `~/.claude`, `~/.gemini`, `.netrc`, `.npmrc`, `.pypirc`, `.git-credentials`, `~/.config/git/credentials`, Gradle and Maven settings and similar), your Keychains and 1904 Desktop’s own data can never be read or written, even inside an allowed folder;
- it cannot send Apple events, open apps, files or links, start background jobs, change preferences, mount disks, or use the pasteboard or the window server;
- it has no network unless the request asks for it and you tick **Allow internet access for this command** in the prompt. With it, a command can reach the internet but not services on this computer over loopback (such as a local database, Jupyter or Docker over TCP), and a server it starts listens on loopback only. A service listening on all of this computer’s addresses may still be reachable through the computer’s network address. Anything that needs local services needs full access.

**Network off is not a privacy setting.** A command’s output goes back to the task in 1904, with or without internet access, so whatever a sandboxed command can read can reach 1904 that way.

**Files in the app’s folder are code.** Anything a sandboxed command writes there (scripts, `package.json` scripts, Makefiles, build files) runs with your full permissions when you or your tools run it later outside the sandbox. Review changes before you run them yourself.

If this Mac has no `sandbox-exec`, sandboxed commands are refused. A process a command deliberately detaches (for example with `setsid` or a double fork) can keep running after the command ends; it stays inside the sandbox.

**Full access asks every time.** A command that asks for full access runs as you, with your permissions, your files, your keys and the network, like a command you type yourself. The prompt says so, and after you choose **Run with full access…** you confirm again with Touch ID, or in a second dialog whose default is Cancel. Full access is never covered by **Allow for this message** or away mode. **Windows has no sandbox yet**, so on Windows every command is treated as full access and asks this way, and away mode is not offered.

**No inherited environment.** A command does not get 1904 Desktop’s environment, so tokens and keys exported there never reach it. It gets `PATH` (on macOS, the one your login shell sets up, read once and nothing else from it), `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG` and `LC_*`, `TERM`, and its own temporary folder; on Windows, the system variables Windows itself needs, `Path`, and its own `TEMP`. Shells start without startup files: `zsh -f`, `bash --noprofile --norc`, PowerShell `-NoProfile`.

**Away mode** lets a task keep working while you are away from this computer. Start it from a prompt (**Allow while I’m away…**) or from the task in the dashboard (right after you click or type in the window); either way you answer native questions here: for how long (30 minutes to 8 hours), whether commands may use the internet (off unless you tick it), and how many commands at most (50 unless you choose otherwise), then Touch ID. On a Mac without Touch ID, after 1904 starts it you see one last question naming 1904’s own title for the task and the limits; Cancel, the default, ends it at once. While it lasts, sandboxed commands for that one task from your messages sent elsewhere (a browser or a phone) run without a prompt; each is listed in Computer Activity and announced with a notification. A message you send from this window still asks as usual, and a command that needs full access still waits for you here. Away mode ends at its time, when its command budget is used, from **1904 → Use My Computer → End Away Mode**, from Computer Activity, or from the dashboard on any of your devices. The cloud can end it but can never start or extend it. Away mode is macOS only for now.

**Pause.** **1904 → Use My Computer → Pause Use My Computer** stops taking requests and closes waiting prompts until you choose **Resume Use My Computer**. A command already running carries on; **Stop** ends it.

**What runs and how long.**

- On macOS, a sandboxed command runs in `/bin/zsh -f`; a full-access command runs in your shell (`$SHELL`, or `/bin/zsh`) without startup files.
- On Windows, commands run in PowerShell 7 (`pwsh.exe`) when it is on your `PATH`, otherwise in Windows PowerShell, without loading your PowerShell profile.
- Input is closed, so a command that waits for input ends. Each command has a time limit set by the request, between 5 seconds and 30 minutes, 2 minutes by default. A command that runs past it is stopped along with everything it started. **Stop** in Computer Activity does the same.
- On macOS, anything a command leaves running in the background (`job &`) is stopped when the command ends. On Windows, a process a command starts in the background, for example with `Start-Process`, can keep running after the command ends, because Windows gives no way to find it once its parent has exited. A time limit or **Stop** reached while the command is still running does stop it.
- The last 48 KB of output and 16 KB of errors go back to the task, together with the exit code, the folder, and how long the command took. 1904 keeps the command text in your workspace’s audit log, so keep passwords and keys out of commands.

**This computer’s own record.** 1904 Desktop keeps a log of every command it was asked to run, what you decided and the end of its output, in `computer-activity.jsonl` in its data folder (the newest 1,000). Computer Activity lists it under **Earlier on this computer**. Nothing sends it anywhere.

**Where commands start.** Each app gets its own folder, `~/1904/<app>` on macOS and `%USERPROFILE%\1904\<app>` on Windows, created the first time a command for that app runs. It starts empty, because the code lives in 1904. To use another folder, such as an existing checkout, choose **Choose folder…** in the prompt, or **Change…** under App folders in **1904 → Computer Activity**. **Reset** goes back to the default.

**Where the keys are kept.** When you connect, 1904 issues a token and a proof key for this computer. 1904 Desktop keeps both in `computer-link.json` in its data folder (`~/Library/Application Support/1904 Desktop` on macOS, `%APPDATA%\1904 Desktop` on Windows), encrypted with your system’s key store through Electron’s `safeStorage`: the Keychain on macOS and DPAPI on Windows. If that storage is not available, the computer is not connected. Only the app’s main process reads them. The dashboard page can ask whether this computer is connected or paused, start the connect prompt, and start the away-mode questions for a task, and nothing else: it cannot run or approve a command, read output, or read either key. A pairing lapses after 30 days without use; 1904 Desktop then asks you to connect the computer again.

**How to disconnect.** Choose **1904 → Use My Computer → Disconnect This Computer…**. Running commands stop, waiting prompts close, away mode ends, 1904 is asked to revoke the token, and the keys and the list of sent messages are deleted from this computer, even when 1904 can’t be reached. To cut off a computer you no longer have, disconnect it under Computers in 1904 Settings; 1904 Desktop on that computer stops as soon as 1904 refuses its token.

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
