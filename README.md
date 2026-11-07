# Spool

Spool screenshots a whole scrolling chat or page and gets it ready for your AI. Select. Scroll. Paste.

<!-- Demo: add a short screen recording or GIF of a capture here. -->

Chat threads, long documents and mail lists scroll inside a panel, so a normal screenshot cuts
them off. With Spool you drag a box around the panel and scroll it. Spool joins the steps into one
tall image. It also cuts that image into AI screenshots, each sized so an AI can read every line
without shrinking it.

When you click **Copy & save**, Spool:

1. Copies the full image to your clipboard. Paste it with Ctrl+V (Cmd+V on a Mac).
2. Saves the full image and the AI screenshots to a folder on your computer.
3. Keeps the AI screenshots ready. In your chat tab, press the Insert last capture shortcut to add
   all of them to your message at once.

Spool needs Chrome 120 or later, or another Chromium browser such as Brave, Edge or Perplexity
Comet. It has no account, no server and no network access.

Spool is tested in Chromium with automated tests on Linux, and its unit tests also run on macOS and
Windows. Nobody has used it yet on a real Mac or a real Linux desktop. Treat those two as
unverified, and please report what you find.

## Install

1. **Get Spool.** If someone sent you a Chrome Web Store link, open it, click **Add to Chrome**
   and go to step 3. Otherwise download `spool-<version>.zip` from the
   [latest release](https://github.com/swarnavspujari/spool/releases/latest) and unzip it into a
   folder you will keep, for example `Documents/Spool`.
2. **Load it (zip only).** Open `chrome://extensions`, turn on **Developer mode**, click **Load
   unpacked** and pick the folder that contains `manifest.json`.
3. **Set it up.** Pin Spool from the puzzle-piece menu. A Welcome tab opens. Click **Save to
   Pictures › Screenshots** and approve the browser's prompt.

The [install guide](docs/guides/install.md) has every click for Windows, Mac and Linux.

## Use

1. Open a long page and press the start shortcut, or click the Spool button in the toolbar.
2. Click a panel, or drag a box around the area.
3. Click **Scroll** (or press Space) until you reach the end, or click **Auto**.
4. Click **Copy & save** (or press Enter).
5. Paste into your chat with Ctrl+V, or use the Insert last capture shortcut in a browser chat tab.

The [usage guide](docs/guides/using-spool.md) covers scrolling up, sticky bars, long captures and
Settings.

## Shortcuts

| Action | Windows and Linux | Mac |
|---|---|---|
| Start a capture | Alt+Shift+S | Control+Shift+S |
| Insert last capture (in your chat tab) | Alt+Shift+V | Control+Shift+V |
| Paste the full image | Ctrl+V | Cmd+V |

Paste with Ctrl+V, not Ctrl+Shift+V. Ctrl+Shift+V is the browser's paste-as-plain-text command, so
an image on the clipboard pastes nothing. Spool does not bind it. On a Mac the same holds for
Cmd+Shift+V.

Change the first two on `chrome://extensions/shortcuts`. If another extension owns a key, the
browser leaves it empty until you choose another.

## Where your files go

The default folder is `Pictures/Screenshots`. The Welcome tab sets it with one click. The browser
grants Spool access to your Pictures folder, because a browser grants a whole folder at a time.
Spool writes only inside `Screenshots`.

```text
Pictures/Screenshots/
  Spool 2026-11-07 14.30.05 Inbox - Mail.png            the full image
  Spool for AI/
    Spool 2026-11-07 14.30.05 Inbox - Mail/
      screenshot-01-of-05.png                           the AI screenshots
      screenshot-02-of-05.png
      ...
```

A short capture that already fits one image saves only the full image. Spool never overwrites a
file: a name that exists gets ` (2)`.

Your browser may forget its permission for the folder when you close the tab where you picked it,
and after a restart. The first capture after that can land in `Downloads/Spool`. The toast says so
and offers a one-click **Reconnect**. Click it and choose **Allow on every visit**, and the browser
stops forgetting.

## Privacy

Spool makes no network request. It has no host permission, and its Content Security Policy blocks
network access from its pages. Captured images stay in memory until you finish, then go to your
clipboard and your folder. The full policy is in [docs/privacy.md](docs/privacy.md). The reason for
each permission is in [docs/threat-model.md](docs/threat-model.md).

Two things to know. Spool copies the full image to your clipboard on every **Copy & save**, and
clipboard history on your system can keep it. Turn that off in Settings with "Copy the full image
when you finish". Also, a web page can tell that a capture runs, so look at your screenshots before
you give them to an AI when the page is not yours.

## Updating

A Chrome Web Store install updates itself within a few hours. A zip install updates when you
replace the contents of the same folder with the new release and click **Reload** on the Spool card
at `chrome://extensions`. Keep the folder path. The browser derives the extension ID from it, and a
new path loses your settings. See the [update guide](docs/guides/update.md).

## Troubleshooting

- **Ctrl+Shift+V pastes nothing.** Use Ctrl+V (Cmd+V on a Mac).
- **Files land in Downloads, not Pictures.** The browser forgot the folder permission, which can
  happen on the first capture after you close the Welcome tab. Click **Reconnect** on the toast,
  and choose **Allow on every visit**.
- **Spool does nothing on this page.** Spool cannot run on browser pages, the Chrome Web Store, the
  built-in PDF viewer or in private windows. Try a normal web page.

The [troubleshooting guide](docs/guides/troubleshooting.md) has more.

## Development

There is no build step and no runtime dependency. Start with
[docs/development.md](docs/development.md), then read [CONTRIBUTING.md](CONTRIBUTING.md) for the
rules. [docs/architecture.md](docs/architecture.md) explains how the parts work and
[docs/contracts.md](docs/contracts.md) defines the interfaces between them. Maintainers: see
[docs/guides/releasing.md](docs/guides/releasing.md) and
[docs/guides/publishing-to-chrome-web-store.md](docs/guides/publishing-to-chrome-web-store.md).
Report a vulnerability as described in [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
