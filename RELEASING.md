# Public releases

The Windows x64 installer and the Apple Silicon and Intel Mac archives each include the Electron runtime. Recipients need the installer or Mac ZIP for their device and internet access to use the hosted 1904 dashboard.

The GitHub Actions workflow **Build signed desktop release** builds on native Windows x64, Apple Silicon, and Intel Mac runners. It signs Windows builds with Azure Artifact Signing, signs and notarizes Mac builds with Developer ID, then checks the installer checksum, signing, update settings, and app launch. Manual runs upload the verified artifacts for review. A stable version tag also publishes them to [1904 Desktop Releases](https://github.com/1904-ai/1904_dashboard/releases).

## Configure once

1. In `1904-ai/1904_dashboard`, create the `desktop-release` GitHub environment. Restrict it to trusted reviewers and the protected release branch and version tags. The signed app embeds this public repository as its update feed.
2. Configure the Windows Public Trust signing profile. Set environment variables `DESKTOP_SIGNING_ENDPOINT`, `DESKTOP_SIGNING_ACCOUNT`, `DESKTOP_SIGNING_PROFILE`, and `DESKTOP_WINDOWS_PUBLISHER`. The publisher must match the signing certificate's common name exactly. Give the Windows signing service principal the Artifact Signing Certificate Profile Signer role on that profile.
3. Add a federated credential to the Windows signing Entra app with issuer `https://token.actions.githubusercontent.com`, subject `repo:1904-ai@309415276/1904_dashboard@1451688227:environment:desktop-release`, and audience `api://AzureADTokenExchange`. Set `AZURE_TENANT_ID` and `AZURE_CLIENT_ID` as environment secrets. The Windows workflow exchanges its GitHub OIDC token for an Azure CLI session that Electron Builder uses for signing.
4. Set environment secrets `MAC_CSC_LINK` to the base64 Developer ID Application `.p12`, `MAC_CSC_KEY_PASSWORD` to its password, and `APPLE_API_KEY_BASE64`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER` to the App Store Connect notarization credentials.

Keep signing secrets in the release environment. Public files and application source only need the feed URL and signing identity, never the private keys.

## Build and roll out

Browser sign-in, task notifications, saved views, and conversation search depend on the hosted dashboard. Verify the corresponding dashboard and sign-in routes before distributing a build that uses them.

1. Set a stable version in `package.json` and `package-lock.json`. Run the workflow manually on the reviewed branch to check the signed builds before tagging. Select **Verify only the Windows build** to run just the Windows job.
2. Push the matching version tag, such as `v0.3.2` for version `0.3.2`. Once the three builds pass verification, the workflow assembles the Windows installer and both Mac ZIPs, their blockmaps, `latest.yml` for Windows, and one `latest-mac.yml` covering Intel and Apple Silicon. GitHub exposes the release after its assets are uploaded.
3. Install the signed build once on each pilot device. Preview users also need this manual installation. Test sign-in and session persistence, then publish a higher signed version and verify the in-app update and restart on each architecture before wider distribution.
4. Share each platform's actual `.exe` or `.zip` from the published release. Keep earlier release assets available for differential downloads. Ship a higher version to fix a release that users have already installed.

If publishing stops during upload, use the verified `1904-github-release` artifact from the run to complete the draft. Compare its assets with `SHA256SUMS.txt` before publishing it.

An installed signed build checks for updates after startup and every few hours. It downloads an available update in the background and applies it on quit. Users can also select **⋯ → Help → Check for Updates…**. Windows verifies the configured publisher and macOS requires a matching signed app.

Reference: [Electron Builder signing and update configuration](https://www.electron.build/v26/docs/features/auto-update/) and [Apple notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).
