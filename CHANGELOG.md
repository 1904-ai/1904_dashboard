# Changelog

## 0.4.0

- **Use My Computer**: a task’s agent can ask to run a command on this computer, and you decide here. It stays off until you choose **1904 → Use My Computer…** and confirm; the prompt names the 1904 account the computer joins, and Cancel takes the connection back at once.
- Only your own messages: a request is answered only for a message you sent from 1904 Desktop, to that task and app, or inside away mode you started here.
- Every command waits for you in 1904 Desktop’s own prompt window, which shows the task, the app, who asked, the whole command, the folder, whether it is sandboxed or full access, and the agent’s reason, and names any character that is not plain ASCII. It opens after a pause in your typing, **Decline** has the focus, and **Run** waits until the window has been in front for a moment and you have seen the whole command. A command too long to show in full is never run.
- When you run a command you choose what else it allows: **Only this command**, **The rest of this message**, or **Everything this task asks** for 30 minutes to 8 hours, from messages you send that task from this window. End an allowance from the 1904 menu or Computer Activity; Pause, Disconnect and quitting end them too.
- On macOS, commands run in a sandbox that denies everything except what command-line tools need: they can change files only in the app’s folder (never git’s settings, hooks or worktree links, editor, dev container or coding-agent settings, or commit-hook configuration, in any letter case), can’t read your home folder beyond the app’s folder and toolchains, never your keys, git’s global settings or this app’s data, can’t open apps or links, and have no internet unless you allow it in the prompt. With internet, they still can’t reach services on this computer over loopback.
- On macOS, full access asks every time and is confirmed with Touch ID where the Mac has it. On Windows, which has no sandbox yet, every command runs with full access and your allowances cover it.
- Commands no longer get the app’s environment, and shells start without startup files, so tokens set there never reach a command. A sandboxed command’s git uses a settings file with only your name and email.
- **Away mode** (macOS): let one task keep running sandboxed commands from your messages sent elsewhere while you’re away, for 30 minutes to 8 hours and up to a command budget. Each command is listed and announced. End it from the 1904 menu, Computer Activity or the dashboard.
- **Pause Use My Computer** in the 1904 menu stops all requests until you resume.
- Commands start in `~/1904/<app>` (`%USERPROFILE%\1904\<app>` on Windows), created the first time. Point an app at another folder, such as an existing checkout, with **Choose folder…** or from Computer Activity.
- **Computer Activity** shows each command, its output as it runs, and its exit code, with a Stop button, plus the last 1,000 commands from this computer’s own log. A mark in the title bar shows while a command runs.
- On Windows, commands run in PowerShell 7 when it is installed, otherwise in Windows PowerShell.
- Disconnect from **1904 → Use My Computer → Disconnect This Computer…**, or remove the computer in 1904 Settings. A connection unused for 30 days lapses; connect the computer again.
- When 1904 can’t be reached, the window says so and keeps trying on its own, then returns to the page you were on. No error page, and nothing to click unless you want to retry sooner.
- The message tells you whether you’re offline, 1904 can’t be reached, or 1904 itself isn’t responding.
- A page that crashes reloads by itself. If it crashes again straight away, you get a Reload button instead of a loop.
- Import a repository from the **…** menu under Help.
- The active task’s name and actions sit in the title bar.
- When a task shows its tabs, **Ctrl+T** and **Ctrl+W** (**Cmd+T** and **Cmd+W** on macOS) open and close the task’s tabs, and **Ctrl+Tab** and **Ctrl+Shift+Tab** move between them. Anywhere else, **Ctrl+W** (**Cmd+W**) still closes the window.
- Updates are published through GitHub Releases.
- Right-click works: cut, copy, paste and select all in text boxes, copy selected text, open a link in your browser or copy its address, copy an image, and fix a misspelled word or add it to the dictionary.
- **Open Copied 1904 Link** opens the copied link instead of showing a JavaScript error.
- The released app is locked down: it can’t be started as Node.js or with a debugger or remote debugging port attached, it ignores `NODE_OPTIONS`, and it runs only the code it was signed with. On macOS, that keeps another program on your computer from borrowing it to read the Use My Computer keys from the Keychain. To debug the app, run it from source with `npm start`.
- Your sign-in cookies are now encrypted on disk with your system’s key store (Keychain on macOS, DPAPI on Windows), like the Use My Computer keys. Updating keeps you signed in; each cookie is encrypted the next time 1904 updates it. Installing 0.3.x again after 0.4.0 signs you out.

## 0.3.1

- Find Help in the title bar’s **…** menu, with version info, release notes, documentation, support, and update controls.

## 0.3.0

- Sign in through your browser and return to 1904 Desktop.
- Open shared task links in the app and jump to tasks from desktop notifications.
- Restore the previous window size and position when reopening the app.
- Open release notes from Help and restart to apply a downloaded update in builds with a configured update feed.

See [GitHub Releases](https://github.com/1904-ai/1904_dashboard/releases) for available packages.
