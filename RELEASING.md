# Public releases

The Windows x64 installer and the Apple Silicon and Intel Mac archives each include the Electron runtime. Recipients need the installer or Mac ZIP for their device and internet access to use the hosted 1904 dashboard.

The manual GitHub Actions workflow **Build signed desktop release** builds on native Windows x64, Apple Silicon, and Intel Mac runners. It signs Windows builds with Azure Artifact Signing, signs and notarizes Mac builds with Developer ID, then checks the installer checksum, signing, update settings, and app launch. Artifacts are uploaded to the workflow run for review.

## Configure once

1. Put this source in the team's release repository. Create the `desktop-release` environment and restrict it to the team's protected release branch or tags and trusted reviewers.
2. Choose a public HTTPS base URL for the static update files. Set it as the `DESKTOP_UPDATE_BASE_URL` environment variable. The workflow adds `win/x64/`, `mac/arm64/`, and `mac/x64/` to this base URL. Keep the URL stable across releases.
3. Configure the Windows public signing profile. Set environment variables `DESKTOP_SIGNING_ENDPOINT`, `DESKTOP_SIGNING_ACCOUNT`, `DESKTOP_SIGNING_PROFILE`, and `DESKTOP_WINDOWS_PUBLISHER`. The publisher must match the signing certificate's common name exactly. Give the signing service principal permission to sign with that profile and set `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, and `AZURE_CLIENT_SECRET` as environment secrets.
4. Set environment secrets `MAC_CSC_LINK` to the base64 Developer ID Application `.p12`, `MAC_CSC_KEY_PASSWORD` to its password, and `APPLE_API_KEY_BASE64`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER` to the App Store Connect notarization credentials.

Keep signing secrets in the release environment. Public files and application source only need the feed URL and signing identity, never the private keys.

## Build and roll out

1. Set the release version in `package.json` and update `package-lock.json`. Run the workflow on the reviewed release ref. Wait for all three jobs to pass.
2. Download the workflow artifacts and check `SHA256SUMS.txt`. Share each platform's actual `.exe` or `.zip`. The outer GitHub Actions artifact archive is for the release operator.
3. On clean devices, install the signed build from its downloaded file and sign in to a test account. Open an Agents task and verify that the app keeps its session after restart. Exercise a signed N-to-N+1 update on every supported architecture before the first broad rollout. Preview builds require a one-time manual upgrade to the first signed release.
4. Publish the installer or Mac ZIP and any blockmap to each platform and architecture directory. Publish the corresponding `latest.yml` or `latest-mac.yml` last, after verifying the public files. Use long cache lifetimes for versioned binaries and short or no-cache lifetimes for the `latest` manifest. Keep previously published versioned files available for delta updates.
5. Start with a small group. When using `stagingPercentage` in the Electron update manifest, regenerate the manifest checksum after editing it and record the staged manifest with the release. Increase exposure after pilot validation. If a build needs to be withdrawn, restore the prior feed for clients that have not upgraded and ship a higher-version fix for clients that already have.

An installed signed build checks for updates after startup and every few hours. It downloads an available update and applies it on quit. Users can also select **Help → Check for Updates…**. Windows verifies the configured publisher and macOS requires a matching signed app.

Reference: [Electron Builder signing and update configuration](https://www.electron.build/v26/docs/features/auto-update/) and [Apple notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).
