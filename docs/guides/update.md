# Update Spool

How you update depends on how you installed. If you are not sure, open `chrome://extensions` and
click **Details** on the Spool card. Under **Source**, "Chrome Web Store" means the store. A folder
path next to "Loaded from" means the zip.

## Installed from the Chrome Web Store

Do nothing. Your browser checks for updates every few hours and installs a new version by itself.
To get it sooner, restart your browser.

To force a check:

1. Open `chrome://extensions`.
2. Turn on **Developer mode** at the top right.
3. Click **Update**.
4. Turn **Developer mode** off again.

To see which version you have, click **Details** on the Spool card. The version is also at the
bottom of Spool's Settings page.

If an update asks for a new permission, your browser turns Spool off and asks you to accept the
new permission. Read it, and accept it if you want the update. The release notes list every
permission change.

## Installed from the zip

You update by hand, and you must keep the same folder. The browser derives Spool's ID from the
folder's location. If the location changes, the ID changes, and Spool starts again with default
settings, default shortcuts and no saved folder.

1. Go to the [latest release](https://github.com/swarnavspujari/spool/releases/latest) and
   download `spool-<version>.zip`. Read the release notes first. They list any permission change,
   because an unpacked extension does not ask you to approve one.
2. Open the folder where Spool is installed, for example `Documents/Spool`. Delete everything
   **inside** it. Do not delete the folder itself, and do not make a new one.
3. Unzip the new zip so that its files land in that same folder. `manifest.json` must be directly
   inside it.
   - Windows: right-click the zip, choose **Extract All...**, click **Browse**, pick the `Spool`
     folder, and click **Extract**. If a new `spool-<version>` folder appears inside, move its
     contents up one level and delete the empty folder.
   - Mac: double-click the zip. Select everything in the new folder and drag it into the `Spool`
     folder.
   - Linux: run `unzip -o ~/Downloads/spool-<version>.zip -d ~/Spool`.
4. Open `chrome://extensions`. On the Spool card, click the circular arrow, **Reload**.
5. Click **Details** and check the version.

You do not need to reload the web pages you have open. Spool injects its scripts again each time
you start a capture. If you are in the middle of a capture, finish it before you reload, because
a reload ends it.

## Move from the zip to the store

The store version has its own ID, so it does not share settings with the zip version. It starts
with defaults. Do the Welcome step again to choose a save folder.

1. Install Spool from the store link. See the [install guide](install.md).
2. On `chrome://extensions`, remove the zip copy of Spool. Two copies would both claim the same
   shortcuts.
3. Delete the old Spool folder if you like. Your saved screenshots are in your own folder and stay.

## When an update did not work

- **The version did not change.** For the store: restart the browser, then force a check as above.
  For the zip: check that `manifest.json` is directly in the folder and not one level deeper, then
  click **Reload** again.
- **Spool lost its settings.** The folder moved, so the ID changed. Put the files back in the
  original folder if you can, or set Spool up again. See the
  [troubleshooting guide](troubleshooting.md).
- **The card shows an error.** Click **Errors** or **Details** and read the message. If it names a
  missing file, the unzip was incomplete. Delete the contents of the folder and unzip again.
