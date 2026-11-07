# Using Spool

This guide covers a capture from start to paste, what the toast offers, how to get the pictures
into your AI, and every setting. For installation, see the [install guide](install.md).

## Make a capture

1. Open the page and press the start shortcut (**Alt+Shift+S** on Windows and Linux,
   **Control+Shift+S** on a Mac), or click the Spool button in the toolbar. The toolbar button's
   tooltip says "Spool it".
2. Choose the area. Click a panel to select all of it, or drag a box. As you move the pointer, Spool
   outlines the scrolling panel under it and labels it "Click to spool this panel". A chat thread
   or a mail list is usually one panel.
3. Click **Scroll**. Spool scrolls one step and adds the new part. Click again until you reach the
   end, or click **Auto** to scroll by itself.
4. Click **Copy & save**.

To select with the keyboard, press Tab or Shift+Tab to move between panels and Enter to select the
highlighted one. With no panel highlighted, Enter selects the main panel. Esc cancels.

Before you select an area only Esc works. Spool reacts only to real key presses and clicks, so a
script on the page cannot press its buttons.

### The control bar

| Button | Keys | What it does |
|---|---|---|
| **Scroll** | Space or Down arrow | Scroll down one step and add it. |
| Up arrow button | Up arrow or Shift+Space | Scroll up one step and add it, to include content above where you started. |
| **Auto** | A | Scroll down by itself. Press again, or press Space, to stop. |
| **Copy & save** | Enter | Finish. Copy the full image and save the files. |
| Cancel (cross) | Esc | Discard the capture and restore the page. It is off while **Copy & save** is saving. |

When the setting "Copy the full image when you finish" is off, **Copy & save** is called **Save**.

The readout shows the number of steps, the height in pixels and the number of AI screenshots, for
example "4 steps · 6,240 px · 3 AI screenshots".

Auto scrolls down only. It stops when:

- the area reaches the end. The bar shows "End of panel", and focus moves to **Copy & save**.
- the image reaches the maximum length.
- three steps in a row add nothing new ("No new content found.").
- you press **Auto**, **Copy & save** or Cancel.
- a step fails.
- you switch tabs. Auto pauses until you return.

Keep the tab and window visible during a capture, because the browser can capture only the visible
tab. If you click **Copy & save** before Spool has stored a step, nothing is saved. The bar says
"Nothing was captured yet. Scroll once, or Cancel." and stays open.

Once **Copy & save** starts saving, you cannot cancel. The Cancel button is off and Esc does
nothing until the toast shows the result. A save that takes more than three minutes stops waiting:
the bar says so, and Cancel works again.

### Sticky bars and fixed bars

"Hide sticky and fixed bars" is on by default. From the first step on, Spool changes the elements
over your area:

- A sticky element, such as a date divider, shows once at its natural place.
- A fixed element is hidden. This covers headers, footers, chat boxes and fade gradients, which
  would repeat in every step.

Spool never hides a fixed element that contains the panel you scroll. It restores every element,
and the scroll position, when the capture ends or is cancelled.

### When a step fails

The control bar shows the reason, and **Copy & save** and Cancel stay available. Spool does not
store the failed step. It captures that step again before it scrolls on, so a failed step never
leaves a gap.

## After Copy & save

Spool does four things:

1. It copies the **full image** to your clipboard.
2. It saves the full image, and the AI screenshots when there is more than one, to your folder.
3. It shows a toast at the bottom right of the page. The toast never takes the keyboard focus,
   closes itself after 6 seconds, stays while you hover or focus it, and closes with Esc.
4. It keeps the AI screenshots ready for 60 minutes, or until your next capture.

### The toast

A short capture fits one image. The toast shows a thumbnail, "Copied and saved", the size, where it
was saved, **Open**, and a reminder to paste with Ctrl+V.

A long capture needs several AI screenshots. The toast says "Copied. Press Ctrl+V for the full
image." It shows how many AI screenshots are ready, a block that says "Long capture? In your chat
tab, press Alt+Shift+V to insert all N screenshots.", and a line for desktop apps that names the
`Spool for AI` folder. It also shows one numbered chip per screenshot. For your first three long
captures the toast stays until you close it, so you have time to read it.

| Control | What it does |
|---|---|
| **Open** | Opens the capture page in a new tab next to the page. |
| Numbered chip | Copies that one AI screenshot. It shows "Copied" for 2 seconds. |
| **Show in folder** | Shows the saved file. It appears for a save in Downloads only, because the browser cannot reveal a folder you picked. |
| **Change** | Opens the folder choice. It appears when Spool saved to Downloads. |
| **Set up** | Opens the folder choice. It appears when no folder is chosen. |
| **Reconnect** | Restores a folder the browser forgot. |

When something failed, the toast says what. "Saved, not copied" or "Not copied" means the
clipboard write failed, and **Open** lets you copy from the capture page. See the
[troubleshooting guide](troubleshooting.md).

### Get the pictures into your AI

Spool gives you two kinds of picture, because they serve different readers.

- The **full image** is one tall picture for people and for your records. It is on your clipboard
  after **Copy & save**. Paste it with **Ctrl+V** (**Cmd+V** on a Mac). For a short capture, it is
  also the best image for an AI, because one image is one AI screenshot.
- The **AI screenshots** are the same picture cut into pieces, each sized so an AI reads every
  line without shrinking it. A clipboard holds one image at a time, so these take another route.

For a browser chat tab, use Insert last capture:

1. Click the message box.
2. Press **Alt+Shift+V** (**Control+Shift+V** on a Mac). A card shows the last capture, where it
   came from and which site it will go into.
3. Click **Insert N screenshots**. Spool puts them in the message as pasted files.
4. Check the message and send it.

The card also has a numbered chip for each screenshot and **Copy full image**. Esc closes it.
Notes:

- It inserts at most 20 screenshots at a time, because most chats accept 20 images in a message.
  It offers the rest next.
- A site may refuse the pasted files. Then the card walks you through **Copy screenshot 1 of N**,
  Ctrl+V, and the next one.
- It works only after a real key press and click, so no web page can open it. It ignores a click
  while something covers it.
- In a desktop app it does not work, because it runs in browser tabs only. Drag the files out of
  the `Spool for AI` folder instead, or paste the full image with Ctrl+V.

Use Ctrl+V, not Ctrl+Shift+V. Ctrl+Shift+V is plain-text paste, so images vanish.

### The capture page

**Open** on the toast opens the capture page. Copy & save does not open it by itself. It has two
views of the last capture:

- **For AI** lists the AI screenshots, each labelled "Screenshot 2 of 5", with **Copy** and
  **Save**. **Save all** saves the screenshots, the full image, or both, as your settings say.
- **For people** shows the full image in a scroll area, with **Copy image** and **Save**.

**Show in folder** and a button to allow the folder appear in the bar at the bottom when they
apply. The capture page saves to `Downloads/Spool`. **Copy & save** saves to the folder you chose.
If a capture has warnings, such as a seam Spool could not verify, the page lists them.

## Why AI screenshots

An AI that reads images shrinks any image beyond its limits. A tall image shrinks a lot. A 1,200 ×
12,000 px image becomes about 258 × 2,576 px, and you cannot read the text.

An AI screenshot stays within the limits of its size setting, so the AI reads every pixel.

| Setting | Long edge | Patches |
|---|---|---|
| High resolution (current models) | 2,576 px | 4,784 |
| Standard (older models) | 1,568 px | 1,568 |

A patch is a 28 × 28 px square. Spool makes each screenshot as tall as both limits allow. For a
1,200 px wide image, the High resolution size is 1,200 × 2,576 px and the Standard size is
1,200 × 1,008 px. The image width is your area's width times your display scaling. Spool scales a
screenshot down only when the image is wider than the long edge.

Neighbouring screenshots share 56 px of rows, so a line of text is whole in at least one of them.
[docs/architecture.md](../architecture.md) has the formulas.

## Where files are saved

Spool saves the moment you click **Copy & save**, to the first of these that works:

1. The folder you chose, usually `Pictures/Screenshots`, if the browser currently allows it.
2. `Downloads/Spool`. You can rename that subfolder in Settings.

```text
Pictures/Screenshots/
  Spool 2026-11-07 14.30.05 Inbox - Mail.png
  Spool for AI/
    Spool 2026-11-07 14.30.05 Inbox - Mail/
      screenshot-01-of-05.png
      ...
      screenshot-05-of-05.png
```

- The full image is a flat file named with the start time and the page title, cut to 48
  characters.
- The AI screenshots sit in `Spool for AI`, in one folder per capture, numbered from top to bottom.
- A short capture that fits one image saves one flat file. It is the full image, or the screenshot
  when "Save full image" is off. Never both.
- A name that exists gets ` (2)`. Spool never replaces a file.
- With "Save AI screenshots" and "Save full image" both off, Spool saves nothing, and the toast
  says "Not saved".

To choose or change the folder, open Settings and use the Save location group. The Welcome tab,
the toast and the Reconnect card all lead there.

## Settings

Open Settings in any of these ways:

- Right-click the Spool icon and choose **Options**. That is your browser's name for Spool's
  Settings page.
- Open `chrome://extensions`, click **Details** on the Spool card, then **Extension options**.
- Click the Settings button (the sliders icon, top right) on the capture page, or **Set up**,
  **Change** or **Reconnect** on the toast.

| Setting | Default | Choices | What it does |
|---|---|---|---|
| Overlap between steps | 80 px | 32, 64, 80, 96, 128 | Repeats a thin strip of the last view, so no line is cut in half and Spool can check the seam. |
| Wait after each scroll | 350 ms | 150, 350, 600, 1 s, 2 s | Spool waits this long before it captures. Use more for pages that load as you scroll. |
| Maximum length | 40,000 px | 20,000, 40,000, 100,000 | A safety stop for endless feeds, counted in page pixels. |
| Hide sticky and fixed bars | On | On or off | Keeps headers and footers from repeating down the image. |
| AI screenshot size | High resolution | High resolution or Standard | How Spool cuts the tall image for your AI. |
| Save AI screenshots | On | On or off | One PNG each. **Save all** includes them. |
| Save full image | On | On or off | One tall PNG for people and for your records. |
| Copy the full image when you finish | On | On or off | Some systems keep a history of what you copy (Windows, and a Mac with Universal Clipboard). Turn this off to copy only when you ask. |
| Downloads folder name | Spool | Up to 40 characters | The folder Spool makes in Downloads when no folder is chosen. |
| Save location | Downloads › Spool | A folder you pick | Shows the place and its state: connected, needs one click, or not found. |

Values outside a limit move to the nearest limit, and the status line tells you what changed.
**Discard** returns to the saved values. **Reset to defaults** restores everything.

The Shortcut group shows the keys for "Start Spool" and "Insert last capture". **Change** opens your
browser's shortcuts page, because the browser owns those keys.

## Limits

| Limit | What happens | What to do |
|---|---|---|
| Restricted pages | Spool cannot run on browser pages, extension pages, `view-source:` pages and the store pages. The button shows `!` for 4 seconds. | Open a normal web page. |
| Private windows | Spool does not run in them, on purpose. | Use a normal window. |
| Built-in PDF viewer | It is not a normal web page. | Use another tool. |
| Local files | You may need "Allow access to file URLs" on the Spool card. This is not tested. | Turn on the switch. |
| Capture speed | The browser allows 2 captures a second, so Spool waits at least 0.55 s between them. | A capture of 20 screens takes 11 s or more. |
| Frames | Spool runs in the top frame only. It cannot scroll an area inside a frame from another site. | Open the frame's address in its own tab. |
| Comet side panel | It is part of the browser, not a web page. | Open the thread in a normal tab. |
| Scroll-hijacking pages | Parallax and canvas-only pages can give bad seams. | Check the warnings. Raise the overlap. |
| Zoom and window size | Changing either during a capture stops the next step. | Finish with what you have, or cancel and restart. |
| Memory | One capture holds up to 512 MiB of stored data, and all captures together up to 1 GiB. The image is at most 300,000 px high. | Finish the capture. |
| Clipboard size | A full image over 40 MiB, or too tall to decode (about 44,800 px at 1,500 px wide), does not go on the clipboard. | Use the AI screenshots or the file. |
| Clipboard on some pages | A page can block the clipboard. An `http://` page has no clipboard API. Spool then writes from its background worker. | If that fails too, use **Open**. |
| Drag and drop | Chromium cannot drag several files to another tab, so Spool has no "drag all". | Use Insert last capture. |
