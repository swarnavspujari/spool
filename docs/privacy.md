# Spool privacy policy

Last updated: 2026-11-07. Applies to Spool 1.1.0 and later.

Spool is a browser extension that captures a scrolling area of a web page that you choose, joins
the steps into one image, and saves or copies the result on your computer. This page says what
Spool handles, where it goes, and what it never does.

## In short

- Spool sends nothing anywhere. It has no server, no account, no analytics and no advertising. It
  makes no network request, and its Content Security Policy blocks network access from its pages.
- Spool works only when you start it, with its toolbar button or a shortcut. A capture runs only
  in the tab where you start it. The Insert last capture card runs in the tab where you press its
  shortcut, which can be a chat tab other than the one you captured.
- Your captures stay on your computer: in memory while you work, then on your clipboard and in a
  folder that you chose.
- Spool does not collect, share, sell or transfer your data.

## What Spool handles

**Website content that you capture.** At each step of a capture, Spool takes a picture of the
visible tab and keeps only the part that you selected. It drops the rest in the hidden extension
page. When you click **Copy & save**, Spool joins the parts. Pictures of a page can show personal
information, because the page shows it to you. Spool handles this content only on your computer,
only after you start a capture, and only for the single purpose of making your screenshot.

- While you capture, the pictures are held in memory by an extension page that the browser hides.
  They are not written to the extension's storage.
- After you click **Copy & save**, Spool builds the full image and the AI screenshots, writes
  the files to your folder, and puts the full image on your clipboard. Spool keeps the finished
  capture in memory for up to 60 minutes, or until your next capture, so that you can insert it
  into a chat or open it again. Closing the browser ends it. A capture page that you opened keeps
  its own copy until you close that tab.
- The browser can move data that an extension holds in memory to a temporary file on your disk when
  memory is short. Spool cannot prevent or see this. The browser deletes the file when it frees the
  data.
- An unfinished capture that you leave is dropped after 30 minutes without a new step.

**The address and title of the page.** Spool reads the address of the active tab to refuse pages
where it cannot run, such as browser pages. It keeps the page title (cut to 200 characters), and
uses up to 48 of its characters in the names of the files it saves. The Insert last capture card
shows the host name of the page you captured and the host name of the page you insert into. Spool
does not store addresses or titles in extension storage.

**Files that you ask for.** Spool writes the full image and the AI screenshots to the folder you
chose, for example `Pictures/Screenshots`, or to `Downloads/Spool` when no folder is available.
These are ordinary files. They stay until you delete them. If your folder syncs to cloud storage,
the files sync with it. The browser's download history also records the names of files saved to
Downloads.

**The clipboard.** After **Copy & save**, Spool writes the full image to the clipboard. When you
click a screenshot chip on the toast, or a chip or **Copy full image** on the Insert card, it writes
that image too. Other programs that run on your computer can read the clipboard, and your system may keep a clipboard
history. Spool never reads the clipboard. You can turn the copy off in Settings with "Copy the
full image when you finish".

## What Spool stores

| Data | Where | Why |
|---|---|---|
| Your settings: numbers, on and off switches, a folder name | `chrome.storage.sync` | To remember your choices. If you turn on browser sync, your browser can sync these settings through your account. That is a browser feature. |
| Three small counters: how often Spool asked where to save, how many long toasts it showed, how often you reconnected the folder | `chrome.storage.local` | To stop asking, and to teach the paste keys only a few times. |
| A reference to the folder you picked, and the names of the folders below it | The extension's IndexedDB | To save to the same folder next time. It holds no image data. |
| One number: the browser's ID for the first file of your last save to Downloads | `chrome.storage.session`, which the browser clears when it closes | So that **Show in folder** reveals that file. It holds no name, path or image data. |

Spool never stores image data in the extension's storage.

## What Spool sends

Nothing. Spool has no server to send data to. It does not contact the developer, any third party or
any AI service. When you insert screenshots into a chat, Spool hands the files to the page in your
browser as if you had pasted them. What the chat site does with them is governed by that site, not
by Spool.

## Permissions

Spool asks for six permissions. Each is used only for the capture workflow above.

| Permission | Use |
|---|---|
| `activeTab` | Temporary access to the tab where you press the toolbar button or a Spool shortcut. |
| `scripting` | Show Spool's own controls in that tab. |
| `offscreen` | Hold and join the pictures in a hidden extension page. |
| `storage` | Keep your settings. |
| `downloads` | Save files to Downloads when your own folder is not available or you use a Save button on the capture page, and show a saved file in its folder. |
| `clipboardWrite` | Put the full image on the clipboard when the page blocks it. |

Spool has no host permissions, so it cannot read any page unless you start it there. It does not
run in private windows. [docs/threat-model.md](threat-model.md) explains each permission in more
detail.

## Limited use

Spool's use of information received from the browser follows the Chrome Web Store User Data
Policy, including its Limited Use requirements. Spool uses website content only to provide the
screenshot feature that you asked for. It does not sell or transfer the data, does not use it for
advertising, credit decisions or anything unrelated to that feature, and no person reads it.

## A web page can see that a capture runs

A page can see scroll events and changes to its own elements, so it can tell that a capture runs.
It could show different content only while you capture. Look at your screenshots before you give
them to an AI when the page is not yours.

## Children

Spool collects no data from anyone, including children.

## Changes

If this policy changes, the date at the top changes, and the change is listed in the
[changelog](../CHANGELOG.md).

## Contact

Ask a question or report a problem by [opening an issue](https://github.com/swarnavspujari/spool/issues/new/choose).
To report a security problem privately, use the
[security advisory form](https://github.com/swarnavspujari/spool/security/advisories/new).
