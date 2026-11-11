# Changelog

## Unreleased

- **Use My Computer**: a task’s agent can ask to run a command on this computer, and you decide here. It stays off until you choose **1904 → Use My Computer…** and confirm.
- Every command waits for you in a native prompt that shows the task, who asked, the whole command, the folder, and the agent’s reason, and names any character that is not plain ASCII. Choose **Decline**, **Run once**, or **Allow for this message**, which covers later commands from the same message in the same folder, for 30 minutes at most, and nothing after it. A command too long to show in full is never run.
- Commands start in `~/1904/<app>` (`%USERPROFILE%\1904\<app>` on Windows), created the first time. Point an app at another folder, such as an existing checkout, with **Choose folder…** or from Computer Activity.
- **Computer Activity** shows each command, its output as it runs, and its exit code, with a Stop button. A mark in the title bar shows while a command runs.
- On macOS, commands run in your login shell. On Windows, they run in PowerShell 7 when it is installed, otherwise in Windows PowerShell.
- Disconnect from **1904 → Use My Computer → Disconnect This Computer…**, or remove the computer in 1904 Settings.
- Right-click works: cut, copy, paste and select all in text boxes, copy selected text, open a link in your browser or copy its address, copy an image, and fix a misspelled word or add it to the dictionary.
- **Open Copied 1904 Link** opens the copied link instead of showing a JavaScript error.

## 0.3.2

- When 1904 can’t be reached, the window says so and keeps trying on its own, then returns to the page you were on. No error page, and nothing to click unless you want to retry sooner.
- The message tells you whether you’re offline, 1904 can’t be reached, or 1904 itself isn’t responding.
- A page that crashes reloads by itself. If it crashes again straight away, you get a Reload button instead of a loop.
- Import a repository from the **…** menu under Help.
- The active task’s name and actions sit in the title bar.
- Updates are published through GitHub Releases.

## 0.3.1

- Find Help in the title bar’s **…** menu, with version info, release notes, documentation, support, and update controls.

## 0.3.0

- Sign in through your browser and return to 1904 Desktop.
- Open shared task links in the app and jump to tasks from desktop notifications.
- Restore the previous window size and position when reopening the app.
- Open release notes from Help and restart to apply a downloaded update in builds with a configured update feed.

See [GitHub Releases](https://github.com/1904-ai/1904/releases) for available packages.
