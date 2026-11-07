# Security policy

## Report a vulnerability

Report it privately through GitHub:
[Report a vulnerability](https://github.com/swarnavspujari/spool/security/advisories/new). Do not
open a public issue and do not post details in a public place.

Include:

1. The Spool version (shown at the bottom of Settings and on `chrome://extensions`).
2. The browser, its version and your operating system.
3. The steps that trigger the problem.
4. What you saw and what you expected.

Do not attach a screenshot that shows private data. Describe the data instead.

## Supported versions

Only the latest release gets fixes. If you run an older one, update first and check that the
problem is still there.

## Scope

In scope:

- The extension code in `src/` and `manifest.json`.
- The release pipeline in `.github/` and `scripts/`, and the zip that it builds.
- A way for a web page, another extension or another program to read a capture, press Spool's
  buttons, send it messages or make it act without a real user gesture.
- A permission that is broader than the feature needs.
- A statement in the documentation that the code does not meet.

Out of scope:

- Anything that needs code already running on your computer as your user. Such a program can read
  your clipboard, your saved files and your browser profile without Spool. The
  [threat model](docs/threat-model.md) lists these residual risks.
- A web page that shows different content while a capture runs. A page can see that a capture
  runs, and Spool cannot hide that. See "A page can detect the capture" in the threat model.
- Findings in a browser or in an operating system. Report those to their vendors.
- Denial of service that a user can end by closing the tab or cancelling the capture.

## What to expect

This is a small project with one maintainer.

- You get an acknowledgement within 7 days.
- You get an assessment, or a request for more detail, within 14 days.
- Fixes ship as a new release, and the release notes say what changed. A serious problem gets a
  fix first and a short public note after users had time to update.
- Say in your report if you want credit. Spool credits the reporter by name in the release notes
  unless you ask it not to.

The permissions, the data Spool handles and the controls that protect them are described in the
[threat model](docs/threat-model.md).
