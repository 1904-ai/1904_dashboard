# Security policy

Report suspected vulnerabilities privately through [1904's contact form](https://1904.ai/contact). Identify the product as **1904 Desktop** and mention if the issue also affects the hosted dashboard. Keep vulnerability details out of public issues, pull requests, and comments.

Include the affected version and operating system, steps to reproduce the issue, and the impact you observed. Redact account details, session cookies, tokens, and private task content. If the report needs sensitive material, request a secure way to share it.

Please coordinate public disclosure with the maintainers so they can investigate and address the issue.

## What the app can do on your computer

1904 Desktop shows the hosted dashboard in a sandboxed window. With **Use My Computer**, it can also run shell commands on your computer for a task’s agent. That feature is off until you choose **1904 → Use My Computer…** and confirm. Once connected:

- Every command waits for your approval in a native prompt on this computer that shows all of it. Nothing a web page or 1904 sends can approve it for you, and settings on 1904 never do. A command too long to show in full is never run. "Allow for this message" ends when the task moves on to another message, and after 30 minutes at most.
- An approved command starts only after 1904 confirms the request still stands.
- An approved command runs as the user signed in to this computer, with that user’s permissions, environment, files, and network access.
- On macOS, background processes a command starts end with it. On Windows, a background process a command starts can keep running after the command exits, because `taskkill /T` cannot follow a parent that has already exited.
- The token 1904 issues for this computer is kept in the app’s data folder, encrypted with the system key store (Keychain on macOS, DPAPI on Windows) through Electron `safeStorage`. Without that storage, the computer is not connected. Only the app’s main process reads the token.
- The dashboard page can only ask whether this computer is connected and open the connect prompt. It cannot run or approve a command, read output, or read the token.
- **1904 → Use My Computer → Disconnect This Computer…** asks 1904 to revoke the token and deletes it from this computer, even when 1904 can’t be reached. Disconnecting the computer in 1904 Settings also revokes it.

The [README](README.md#use-my-computer) describes the feature in full. Reports of a way to run a command without the person’s approval, to approve one from a web page or from 1904, or to read the token are in scope and especially welcome.
