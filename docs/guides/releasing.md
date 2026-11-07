# Releasing Spool

This guide is for the maintainer. A release is a tag. Pushing `vX.Y.Z` on a commit of `main`
builds the zip, writes the notes, publishes a GitHub release and, when enabled, uploads the zip to
the Chrome Web Store. Everything between the tag and the release is automatic.

The first public tag is `v1.1.0`. The repository history was rebuilt before publication, so no
earlier tag is public. 1.0.0 stays in `CHANGELOG.md` as history only.

## One-time repository setup

Do this before the first tag.

1. Log in with the GitHub CLI as a repository admin: `gh auth login`.
2. Apply the base settings: `scripts/repo-settings.sh base`. It sets the description and topics,
   squash-only merges, GitHub-owned actions only with full-hash pinning, a read-only default token,
   secret scanning with push protection, private vulnerability reporting, immutable releases and
   the `E2E_WORKERS` variable.
3. Push `main` and wait for the first green **CI result** check.
4. Apply the rulesets: `scripts/repo-settings.sh rulesets`. The `main` ruleset requires a pull
   request, squash merges and a passing **CI result**, and it blocks force pushes and deletion. The
   `release tags` ruleset lets only repository admins create, move or delete a `v*` tag. Applying
   it earlier would block the first push.
5. Check everything: `scripts/repo-settings.sh verify`.

Immutable releases and the tag ruleset must exist before the first tag. An immutable release keeps
its assets and tag after publication, so nobody can replace the zip afterwards.

## Make a release

1. **Choose the version** `X.Y.Z`, following [Semantic Versioning](https://semver.org/).
2. **Set the version in two files.** `manifest.json` and `package.json` must match. Run
   `npm version X.Y.Z --no-git-tag-version` for `package.json` and `package-lock.json`, and edit
   `manifest.json` by hand. `npm run package` and the release workflow both fail when they differ.
3. **Write the changelog section.** Add `## [X.Y.Z] - YYYY-MM-DD` at the top of `CHANGELOG.md`,
   below the intro. Write it for users first, then the technical detail. The release workflow
   copies this section into the release notes, and it fails when the section is missing, empty or
   marked Unreleased. Do not write notes from commit messages.
4. **Check locally.** Run `npm run check` and `npm run package`. The script prints the file count
   and the SHA-256 of the zip.
5. **Merge through a pull request.** The pull request title becomes the squash commit, so write it
   as a Conventional Commit, for example `chore(release): X.Y.Z`. Merge when **CI result** is green.
6. **Tag the merge commit** on `main`, and push the tag:

   ```text
   git switch main && git pull
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

   Only repository admins can push a `v*` tag.
7. **Watch the workflow.** Run `gh run watch`, or open the **Release** run under Actions.
8. **Verify the release** (below).
9. **Update the store item** if the store job is on. See
   [publishing-to-chrome-web-store.md](publishing-to-chrome-web-store.md).

### Dry run

Open Actions, choose **Release**, click **Run workflow** on a branch. A dry run builds the zip
twice and compares them, checks the changelog section, shows the release notes in the job summary
and keeps the zip as a workflow artifact for seven days. It skips the tag and CI checks and
publishes nothing. Use it to test the install from the artifact before you tag.

## What the release workflow does

`.github/workflows/release.yml` has three jobs.

**build** (read-only):

1. Checks that `manifest.json` and `package.json` have the same version.
2. For a tag push: checks that the tag is `vMAJOR.MINOR.PATCH`, equals `v<version>`, points to a
   commit in the history of `main`, and has a successful **CI result** check run from GitHub
   Actions. It fails otherwise, so wait for CI before you tag.
3. Builds the zip twice with `scripts/package.mjs`, which uses Node built-ins only, and fails if
   the two differ.
4. Writes the release notes with `.github/scripts/release-notes.mjs` (below).
5. Uploads the zip, its `.sha256` file and the notes as one artifact.

**publish** (write access, no checkout, no npm):

1. Downloads the artifact and checks that it holds exactly the three expected files and that the
   hashes match.
2. Attests the zip with GitHub's build provenance, which ties it to this workflow, commit and tag.
3. Creates the release as a draft, uploads the files, then publishes it. Immutable releases need
   that order.
4. Runs `gh release verify`. It warns, and does not fail, when immutable releases are off.

**store** (optional): uploads the same zip to the Chrome Web Store. It runs only for a tag push,
only after **publish** succeeded, and only when the repository variable `CWS_ENABLED` is `true`.
A store failure never blocks the GitHub release. See the publishing guide.

### Release notes

`release-notes.mjs` joins the changelog section with `.github/RELEASE_TEMPLATE.md`. The template
fields are `{{notes}}`, `{{version}}`, `{{tag}}`, `{{repo}}`, `{{zip}}`, `{{sha256}}`,
`{{permissions}}` and `{{compare}}`. A field that the script does not know fails the build.

The permissions line compares `manifest.json` at the tag with the manifest at the previous
`vX.Y.Z` tag. If the permissions changed, it says so in bold. An unpacked extension does not ask
users to approve a new permission, so the notes must. For the first release there is no previous
tag and the line says "unchanged".

## Verify the release

1. Open the release page. It lists `spool-X.Y.Z.zip`, `spool-X.Y.Z.zip.sha256` and the notes.
2. Download both files into one folder and check the hash. On Mac and Linux, run
   `shasum -a 256 -c spool-X.Y.Z.zip.sha256`. On Windows, run
   `Get-FileHash .\spool-X.Y.Z.zip -Algorithm SHA256` and compare it with the text of the
   `.sha256` file.
3. Verify the provenance and the release:

   ```text
   gh attestation verify spool-X.Y.Z.zip --repo swarnavspujari/spool
   gh release verify vX.Y.Z --repo swarnavspujari/spool
   gh release verify-asset vX.Y.Z spool-X.Y.Z.zip --repo swarnavspujari/spool
   ```

4. Install the zip in a fresh browser profile and run the manual checks below.

To rebuild the zip yourself, run `git checkout vX.Y.Z` and `node scripts/package.mjs`. The bytes
match when you use the same Node.js major version as the release workflow, which reads `.nvmrc`. A
different version can compress differently.

## Manual checks before a release

The automated tests run in Chromium on Linux, and the platform smoke job runs the unit tests on
macOS and Windows. A headless run cannot see shortcut labels, the Option key, Retina capture or the
real folder prompt, so a person checks these. Until someone has done so on a real Mac and a real
Linux desktop, say that those platforms are untested.

In a fresh profile, with the zip build:

- The Welcome tab opens. **Save to Pictures › Screenshots** opens the folder window in Pictures,
  and the save works after the prompt.
- A capture of a long page copies and saves. Ctrl+V (Cmd+V) pastes the full image.
- Insert last capture works in a browser chat tab, and shows the source and the destination host.
- Close the Welcome tab and capture: the toast can offer **Reconnect** and the files can land in
  Downloads. The prompt offers **Allow on every visit**, and after you choose it a capture saves to
  the folder with no prompt, also after a browser restart.
- The shortcuts match the Settings page. On a Mac they are Control+Shift+S and Control+Shift+V.

## When a release fails

- **The build job fails.** No release exists. Read the message, fix the cause on `main` through a
  pull request, and tag again. A failed tag has to be deleted first, which only an admin can do:
  `git push origin :refs/tags/vX.Y.Z` and `git tag -d vX.Y.Z`. Delete a tag only when no release
  was published from it.
- **A published release has a defect.** Do not replace its files. Immutable releases forbid it.
  Fix on `main`, and release the next patch version.
- **The publish job fails after the draft exists.** Delete the draft release in the GitHub UI,
  fix the cause, and re-run the workflow or tag again.
- **The notes script fails.** `CHANGELOG.md` has no section for the version, the section is empty,
  it is marked Unreleased, or the template has an unknown field.

## Repository variables

| Name | Where | Purpose |
|---|---|---|
| `E2E_WORKERS` | Repository variable | Browsers per end-to-end job. The default is 3. |
| `CWS_ENABLED` | Repository variable | Turns on the store job when it is `true`. Never set by the settings script. |
| `CWS_PUBLISHER_ID`, `CWS_EXTENSION_ID` | Repository variables | Identify the store item. |
| `CWS_PUBLISH_TYPE` | Repository variable | `STAGED_PUBLISH` (default) or `DEFAULT_PUBLISH`. |
| `CWS_SERVICE_ACCOUNT_KEY` | Secret of the `chrome-web-store` environment | The service account key. |
