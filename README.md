# 1904 Desktop

An Electron app for the live 1904 Agents dashboard. The 1904 service manages accounts, task workspaces, Git worktrees, conversations, and remote terminals. The desktop app opens `https://1904.ai/agents` in a dedicated browser profile.

## Sign in

Choose **1904 → Sign In with Browser**, sign in to 1904, then choose **Open 1904 Desktop** in the browser. You can also sign in directly with your email and password. For an email sign-in link, copy the link address and choose **1904 → Open Copied 1904 Link**. That menu action also accepts copied task links. From a task on the web, choose **Open in 1904 Desktop** in its menu.

The app needs internet access. Use **View → Reload** to reconnect after a failed load. The native notification settings for 1904 Desktop control dashboard notifications on this device.

The title bar follows the dashboard theme. Use **…** in the title bar to open the application menu. The app restores its window size and position. The overview scrolls within the task list or status board, and F6 and Shift+F6 move focus between workspace panes.

Use **Help → About 1904 Desktop** to see the installed version and **Help → What’s New** for release notes. Signed builds with an update feed show **Restart to Update** in Help when an update is ready.

Browser sign-in, task notifications, saved views, and conversation search use the live 1904 control plane. Deploy the matching dashboard and sign-in routes before distributing this version.

## Build from source

Install Node.js 22.12 or later. In this directory run `npm ci`, then `npm start` for development. Use `npm run check` for a syntax check.

| Host | Command | Output |
| --- | --- | --- |
| Windows | `npm run build:windows` | Windows x64 installer in `dist/` |
| macOS | `npm run build:mac` | macOS disk images for Apple Silicon and Intel in `dist/` |

The commands above build previews. The project keeps earlier preview installers in `releases/`. See [Public releases](RELEASING.md) for signed builds, update hosting, and rollout.
