# Troubleshooting

Find your problem in the list, read the cause, and follow the fix. If nothing here helps,
[open an issue](https://github.com/swarnavspujari/spool/issues/new/choose) and say what you pressed
and what you saw. Do not attach a screenshot that shows private data.

- [Pasting](#pasting)
- [Where the files went](#where-the-files-went)
- [Spool does not start](#spool-does-not-start)
- [Shortcuts](#shortcuts)
- [Insert last capture](#insert-last-capture)
- [The toast says something went wrong](#the-toast-says-something-went-wrong)
- [The image has a bad seam or a gap](#the-image-has-a-bad-seam-or-a-gap)
- [A capture stops early](#a-capture-stops-early)
- [Settings or folder disappeared](#settings-or-folder-disappeared)
- [Mac and Linux](#mac-and-linux)

## Pasting

### Ctrl+Shift+V pastes nothing

Ctrl+Shift+V is your browser's "paste as plain text" command. It drops images by design, so an
image on the clipboard pastes nothing. Use **Ctrl+V** on Windows and Linux, or **Cmd+V** on a Mac.
Spool does not use Ctrl+Shift+V. The same holds for Cmd+Shift+V on a Mac.

### Ctrl+V pastes one very tall image, and my AI cannot read it

That is the full image. It is made for people. An AI shrinks a tall image until the text is
unreadable. For your AI, use the AI screenshots instead:

- In a browser chat tab, press the Insert last capture shortcut (Alt+Shift+V, or Control+Shift+V
  on a Mac).
- In a desktop app, drag the files from the `Spool for AI` folder into the chat. The toast shows
  the folder.
- Click a numbered chip on the toast to copy one AI screenshot at a time.

### The clipboard has nothing after Copy & save

Look at the toast. "Saved" with no "Copied" means the setting "Copy the full image when you
finish" is off. Turn it on in Settings, or use the toast to copy. "Saved, not copied" or "Not
copied" means the page blocked the clipboard. Click **Open** on the toast to copy from the capture
page instead. "Too tall to copy. Saved instead." means the image is more than 256 MiB once
decoded, about 44,800 px high at 1,500 px wide. Paste the AI screenshots instead.

## Where the files went

### Files are in Downloads, not Pictures

The toast says "Saved to Downloads › Spool this time" and asks "Reconnect Pictures ›
Screenshots?". Your browser forgot its permission for the folder. It does this when the last Spool
tab closes, and after a restart. The first capture after you close the Welcome tab can land here.
One reconnect with **Allow on every visit** fixes it for good.

1. Click **Reconnect** on the toast. Settings opens with a Reconnect card.
2. Click **Reconnect Pictures › Screenshots**.
3. When your browser asks, choose **Allow on every visit**.

"Allow on every visit" stops the browser from forgetting. Your browser shows it only when you
reconnect, not in the first prompt after you pick the folder. If it never appears,
keep one Spool tab open (Settings is enough), or use Downloads. After the third reconnect Spool
suggests this itself.

### The toast asks "Save to Pictures › Screenshots?"

You have not chosen a folder yet, so Spool saved to `Downloads/Spool`. Click **Set up** to choose.
Spool asks on the first three such captures and then stops. A **Change** link stays on the toast.

### "Folder not found"

The folder you chose was moved or deleted. Open Settings and click **Pick again**, or click
**Save to Pictures › Screenshots**. Deleting only the `Screenshots` folder is fine: Spool makes it
again on the next save.

### Where is my Pictures folder?

Your system decides. On Windows it can sit inside OneDrive, and then Spool's files sync to the
cloud. On Mac it is `~/Pictures`, and Spool creates `Screenshots` there. On Linux it is the
Pictures folder from your desktop settings, possibly in your language. Spool shows the real place
in Settings under Save location.

### Only some files saved

The toast says "Copied, but 2 of 6 files didn't save." Click **Open** and use **Save all** on the
capture page. Spool never overwrites a file. A name that exists gets ` (2)`.

### The file name has no page title

When the browser refuses a character in a name, Spool saves the whole set again without the title.

## Spool does not start

- **A red `!` on the toolbar button.** Spool cannot run on this page. The badge clears after four
  seconds, and hovering the button shows the reason. Spool cannot run on browser pages
  (`chrome://`, `brave://`, `edge://`, `about:`), extension pages, `view-source:` pages, the Chrome
  Web Store and the Edge add-ons site. Open a normal web page.
- **The built-in PDF viewer.** It is not a normal web page, and Spool does not support it.
- **A private window.** Spool does not run in Incognito or private windows, on purpose, so that
  captures stay out of them. Use a normal window.
- **A page on your disk (`file://`).** The browser may require the switch "Allow access to file
  URLs" on the Spool card at `chrome://extensions`. This is not tested.
- **"Spool cannot capture this page. Reload it or try another page."** Spool could not start on
  the page. Reload the page and try again, or try another page.
- **An area inside an embedded frame.** Spool injects into the top frame only, so it cannot scroll
  an area inside a frame from another site. Open the frame's own address in a tab.
- **The Comet assistant side panel.** It is part of the browser, not a web page. Spool cannot
  capture it. A chat thread on a web page works.
- **Nothing happens when you click the toolbar button.** Check that Spool is turned on at
  `chrome://extensions`, then reload the page and try again.

## Shortcuts

- **Another extension or your system owns the key.** Open `chrome://extensions/shortcuts` and
  choose a different key. The browser can leave a key empty when two extensions ask for it. The
  Settings page shows "Not set" in that case.
- **Alt+Shift switches my keyboard language.** With two keyboard layouts, Alt+Shift can switch the
  language. A chord with a letter, such as Alt+Shift+S, does not, but your system may differ.
  Choose another key if it does.
- **Mac.** Spool uses Control+Shift+S and Control+Shift+V. It avoids Option+Shift because Option
  with a letter types a symbol in a text field, and it avoids Command+Shift+S and Command+Shift+V
  because those are Save As and paste-as-plain-text.
- **Linux.** Some desktops claim Alt+Shift+letter. Change the key at
  `chrome://extensions/shortcuts`.
- **A desktop app.** The shortcuts work in browser tabs only. They cannot reach a separate
  application.

## Insert last capture

The card that opens with the Insert last capture shortcut shows the last capture and puts all its
AI screenshots into your message.

- **"Nothing to insert yet. Press Alt+Shift+S to spool a page."** You have no capture, or it is
  more than 60 minutes old. Make a new capture. A new capture also replaces the old one.
- **"Click your message box first."** Click inside the message box, then press the shortcut again.
  Spool pastes where your cursor is.
- **"This chat won't take them all at once."** The site refused the paste. Click **Copy
  screenshot 1 of N**, press Ctrl+V (Cmd+V) in the chat, then come back for the next one. Each paste
  is yours, so this works on every site.
- **"Spool cannot insert into an embedded frame."** Your cursor is in a frame from another site.
  Click a numbered chip to copy one screenshot, then paste.
- **"A newer capture exists. Press Alt+Shift+V again."** You captured again after you opened the
  card. Press the shortcut again.
- **"Something on this page covers Spool. Click again in a moment."** A page element sits over the
  card. Spool ignores the click on purpose, because a page could use that to trick you. Wait a
  moment and click again.
- **More than 20 AI screenshots.** Most chats accept 20 images in a message. Spool offers the
  first 20, then the rest. Send your message between batches.
- **Nothing happens on a desktop app.** The card works in browser tabs only. Drag the files from
  the `Spool for AI` folder, or press Ctrl+V for the full image.

## The toast says something went wrong

| Message | What it means | What to do |
|---|---|---|
| "Saved, not copied" or "Not copied" | The browser or the page blocked the clipboard. | Click **Open** and copy from the capture page. |
| "This image is too large to copy. Use the AI screenshots." | The full image is over 40 MiB. | Paste the AI screenshots, or use the saved file. |
| "Too tall to copy. Saved instead." | The full image is too tall for the browser to put on the clipboard. | Use the AI screenshots or the saved file. |
| "Not saved" | Both save settings are off. | Turn on "Save AI screenshots" or "Save full image" in Settings. |
| "This capture is no longer in memory. Start a new capture." | The capture page opened after the capture ended or the browser closed. | Make a new capture. |

The capture page, which **Open** shows, has two views. **For AI** lists the screenshots with **Save
all**, **Copy** and **Save**. **For people** shows the full image with **Copy image** and **Save**.
The capture page saves to `Downloads/Spool`. **Copy & save** saves to the folder you chose.

## The image has a bad seam or a gap

Spool checks every seam, where two scroll steps meet. When it cannot verify one, the capture page
shows "Spool could not verify 1 seam, near step 3. Check that area." Look at that spot.

Try these, in order:

1. Raise "Wait after each scroll" in Settings, for pages that load as you scroll.
2. Raise "Overlap between steps".
3. Leave "Hide sticky and fixed bars" on, so headers and footers do not repeat down the image.

Pages that take over scrolling, use parallax effects or draw only on a canvas can still give bad
seams. A blank area matches any other blank area, so a mostly blank overlap is reported as
unverified too.

## A capture stops early

| Message on the control bar | Cause | What to do |
|---|---|---|
| "End of panel" | You reached the end. | Click **Copy & save**. |
| "No new content found." | Three steps in a row added nothing. | Click **Copy & save**, or scroll by hand. |
| "Reached the length limit." / "The capture reached its maximum length." | The image hit "Maximum length" in Settings. | Raise it, up to 100,000 px, or capture in two parts. |
| "Go back to this tab to continue." | You switched tabs. The browser can capture only the visible tab. | Switch back. |
| "The window size changed. Cancel and select the area again." | You resized the window. | Cancel and select again, or finish with what you have. |
| "Page zoom changed. Finish now to keep what you have." | You zoomed the page. | Click **Copy & save**, or cancel and start again at one zoom level. |
| "The page moved too far. Finish now to keep what you have." | The page jumped its own scroll position. | Click **Copy & save** to keep what you have. |
| "The browser is limiting screenshots. Wait a moment and try again." | The browser allows two captures a second. | Wait, then scroll again. A capture of 20 screens takes about 11 seconds. |
| "This capture is too large. Finish now to keep what you have." | One capture holds at most 512 MiB. | Click **Copy & save**. |

Keep the tab and the window visible during a capture.

## Settings or folder disappeared

If you installed from a zip, the browser derives Spool's ID from the folder path. When the path
changes, the ID changes, and Spool forgets its settings, shortcuts and folder. Put the files back
in the original folder and click **Reload**, or set Spool up again. A store install keeps its ID.
See the [update guide](update.md).

To start over, open Settings and click **Reset to defaults**. It does not touch your saved files.

## Mac and Linux

Spool has not been tested on a real Mac or Linux desktop. Automated tests run in Chromium on Linux,
and the unit tests run on macOS too. If you hit a problem that this guide does not cover, please
[open an issue](https://github.com/swarnavspujari/spool/issues/new/choose) with your browser, its
version and your system.

On a Mac, your system may ask whether the browser can access your Pictures folder the first time
Spool saves there. Allow it.
