# Install Spool

This guide gets Spool running in your browser. It takes about five minutes. You need Chrome 120 or
later, or another Chromium browser such as Brave, Edge or Perplexity Comet. Windows, Mac and Linux
all work. Mac and Linux have not been tested on real computers yet, so tell us if something
differs.

There are two ways to install Spool. Pick one.

- **The Chrome Web Store link.** This is the easy way. Your browser installs Spool, and keeps it
  up to date for you. Use it if the person who shared Spool with you sent a link.
- **The zip file.** Use this if you have no link, or your browser cannot use the store. You unzip a
  file into a folder, and you update by hand.

After either one, finish with [Set up where screenshots go](#set-up-where-screenshots-go).

## Install from the Chrome Web Store

1. Open the link you were sent, in your browser.
2. Click the blue **Add to Chrome** button. In Brave it says **Add to Brave**. In Edge it says
   **Get**. In Comet, use the install button on the page.
3. A box asks for permission. It says Spool can "Modify data you copy and paste" and "Manage your
   downloads". Spool needs the first to put your screenshot on the clipboard, and the second to
   save files into your Downloads folder when your own folder is not available. Click **Add
   extension**.
4. Click the puzzle-piece icon at the top right of the browser. Find **Spool** in the list and
   click the pin icon next to it. Spool now stays in your toolbar.

A new tab called Welcome opens. Go to [Set up where screenshots go](#set-up-where-screenshots-go).

## Install from the zip file

Do these steps once. The most important rule: **put the folder somewhere you will keep it, and
never move or rename it.** Your browser remembers Spool by the folder's location. If the location
changes, Spool forgets your settings.

### Windows

1. Go to the [latest release](https://github.com/swarnavspujari/spool/releases/latest). Under
   **Assets**, click `spool-<version>.zip` to download it.
2. Open your Downloads folder. Right-click the zip and choose **Extract All...**, then click
   **Extract**. A new folder opens. It has files such as `manifest.json` and a folder called `src`.
3. Make a folder called `Spool` inside your Documents folder. Move everything from step 2 into it,
   so that `Documents\Spool\manifest.json` exists. Do not leave another folder level in between.
4. Open Chrome. Type `chrome://extensions` in the address bar and press Enter.
5. Turn on **Developer mode**. It is the switch at the top right. Leave it on.
6. Click **Load unpacked**. In the window that opens, choose the `Spool` folder and click **Select
   Folder**. A Spool card appears.
7. Click the puzzle-piece icon at the top right. Click the pin icon next to **Spool**.

### Mac

1. Go to the [latest release](https://github.com/swarnavspujari/spool/releases/latest). Under
   **Assets**, click `spool-<version>.zip` to download it.
2. Open your Downloads folder in Finder. Double-click the zip. Finder makes a folder with files
   such as `manifest.json` and a folder called `src`.
3. Make a folder called `Spool` inside Documents. Move everything from step 2 into it, so that
   `Documents/Spool/manifest.json` exists.
4. Open Chrome. Type `chrome://extensions` in the address bar and press Return.
5. Turn on **Developer mode**, at the top right. Leave it on.
6. Click **Load unpacked**. In the window that opens, choose `Documents/Spool` and click **Open**.
   A Spool card appears. Press Cmd+Shift+G in that window to type a path if you cannot find it.
7. Click the puzzle-piece icon at the top right. Click the pin icon next to **Spool**.

### Linux

1. Go to the [latest release](https://github.com/swarnavspujari/spool/releases/latest). Under
   **Assets**, click `spool-<version>.zip` to download it.
2. In a terminal, run:

   ```text
   mkdir -p ~/Spool && unzip ~/Downloads/spool-<version>.zip -d ~/Spool
   ```

   Check that `~/Spool/manifest.json` exists. If it is one folder deeper, move the files up.
3. Open Chrome. Type `chrome://extensions` in the address bar and press Enter.
4. Turn on **Developer mode**, at the top right. Leave it on.
5. Click **Load unpacked**, choose the `Spool` folder in your home folder, and click **Open**. If
   you use a Snap or Flatpak browser, keep the folder in your home folder and not in a hidden
   folder, because the sandbox can block hidden folders.
6. Click the puzzle-piece icon at the top right. Click the pin icon next to **Spool**.

### Brave, Edge and Comet

The steps are the same. The address is `brave://extensions`, `edge://extensions` or
`comet://extensions`. If Comet does not open its own address, use `chrome://extensions`. These
browsers are Chromium browsers, but only Chrome has been tested. If one refuses the folder, use
Chrome.

### Check the download (optional)

Each release has a `spool-<version>.zip.sha256` file next to the zip. It lets you check that the
download is complete and unchanged.

- Windows: in PowerShell, run `Get-FileHash .\spool-<version>.zip -Algorithm SHA256` and compare
  the result with the text in the `.sha256` file.
- Mac and Linux: in a terminal, in the folder with both files, run
  `shasum -a 256 -c spool-<version>.zip.sha256`. It prints `OK`.

## Set up where screenshots go

When Spool installs, a tab called Welcome opens and asks where to save screenshots. If you closed
it, make a capture first. Spool's card then asks "Save to Pictures › Screenshots?". Click **Set
up** to come back here. You can also right-click the Spool icon and choose **Options**, which is
the browser's name for Spool's Settings page, and use the Save location group.

1. Click **Save to Pictures › Screenshots**. A window for choosing a folder opens, already in your
   Pictures folder.
2. Click **Select Folder** (Windows) or **Open** (Mac and Linux). Do not open any folder first.
3. Your browser asks whether Spool can edit files in Pictures. Click **Edit files**. Spool makes a
   folder called `Screenshots` there if you have none.
4. The page now says "You're set." It also says that your browser may forget the folder when you
   close this tab or restart. If your first capture lands in Downloads, click **Reconnect** on the
   toast and choose **Allow on every visit**. That is one click, and the browser then stops
   asking.

Two things to know:

- Your browser grants access to the whole Pictures folder, because a browser can only grant a
  whole folder. Spool writes only inside `Screenshots`.
- If you prefer your Downloads folder, click **Keep using Downloads**. Spool then saves to
  `Downloads/Spool`. You can change your mind later in Settings.

## Try it

1. Open a page with a long list or a long chat.
2. Press Spool's shortcut: **Alt+Shift+S** on Windows and Linux, **Control+Shift+S** on a Mac. Or
   click the Spool button in the toolbar.
3. Click the part of the page you want, or drag a box around it.
4. Click **Scroll** until you reach the end. Or click **Auto**.
5. Click **Copy & save**. A small card appears at the bottom right. It says "Copied and saved", or,
   for a long capture, "Copied. Press Ctrl+V for the full image."
6. Paste into your chat with **Ctrl+V** (Windows, Linux) or **Cmd+V** (Mac).

Use Ctrl+V, not Ctrl+Shift+V. Ctrl+Shift+V pastes plain text, so an image pastes nothing.

To change the shortcuts, open `chrome://extensions/shortcuts`. The [usage guide](using-spool.md)
has the rest. If something does not work, read the [troubleshooting guide](troubleshooting.md).

## Update and remove

See the [update guide](update.md). To remove Spool, open `chrome://extensions` and click **Remove**
on the Spool card. Your saved screenshots stay where they are. Delete them yourself if you want
them gone.
