# Chrome Web Store listing

The text to paste into the Chrome Web Store dashboard for the Spool item, and the checklist of
assets. The steps for submitting it are in
[publishing-to-chrome-web-store.md](../guides/publishing-to-chrome-web-store.md).

Rules for every field:

- Do not name an AI company or product anywhere. Say "your AI" or "AI chat tools".
- State only what the code does. Check a claim against [docs/threat-model.md](../threat-model.md)
  and [docs/privacy.md](../privacy.md) before you change it.
- Use screenshots of a neutral long page, not of a branded chat window.

## Basics

| Field | Value |
|---|---|
| Name | Spool |
| Category | Productivity |
| Language | English |
| Visibility | Unlisted |
| Regions | All regions |
| Homepage URL | `https://github.com/swarnavspujari/spool` |
| Support URL | `https://github.com/swarnavspujari/spool/issues` |
| Privacy policy URL | `https://github.com/swarnavspujari/spool/blob/main/docs/privacy.md` |

## Summary

The store shows the manifest `description` (121 characters, limit 132):

> Screenshot a whole scrolling chat or page. Get one tall image, plus screenshots sized for your AI to read at full detail.

## Description

> Spool screenshots a whole scrolling chat or page and gets it ready for your AI. Select. Scroll.
> Paste.
>
> Long chats, documents and mail lists scroll inside a panel, so a normal screenshot cuts them off.
> With Spool you pick the panel and scroll it. Spool joins the steps into one tall image. It also
> cuts that image into AI screenshots, each sized so an AI can read every line without shrinking
> it.
>
> How it works
> 1. Press Alt+Shift+S (Control+Shift+S on a Mac), or click the Spool button.
> 2. Click a panel, or drag a box around the area.
> 3. Click Scroll until you reach the end, or click Auto.
> 4. Click Copy & save. Spool puts the full image on your clipboard, and saves the full image and
>    the AI screenshots to a folder you choose, by default Pictures/Screenshots.
> 5. Paste the full image with Ctrl+V (Cmd+V on a Mac). To add all the AI screenshots to a chat in
>    your browser, press Alt+Shift+V (Control+Shift+V on a Mac) in that tab.
>
> Private by design
> Spool has no server, no account and no analytics, and it makes no network requests. It works only
> when you start it, with its button or a shortcut. A capture runs only in the tab where you start
> it, and the Insert last capture card runs in the tab where you press its shortcut. It does not run
> on browser pages or in private windows. Your captures stay on your computer.
>
> Good to know
> - Spool checks every seam between steps and tells you about any it could not verify.
> - Sticky headers and fixed bars are shown once, not repeated down the image.
> - Settings control the overlap, the wait after each scroll, the AI screenshot size and what is
>   saved.
> - The Insert last capture shortcut works in browser tabs. In a desktop app, drag the files from
>   the Spool for AI folder.
>
> Spool is an independent open source tool. Its source is at
> https://github.com/swarnavspujari/spool. It is not made by, and not affiliated with, any AI
> company.

## Single purpose

> Spool captures a scrolling area of the current web page as one tall image, plus smaller images
> sized for an AI to read, and delivers them to the user's clipboard, a folder on their computer, or
> a chat field in their browser. Everything in the extension serves that one workflow: the area
> selection, the scrolling capture, the image assembly, saving, the settings page, and the shortcut
> that inserts the last capture into a page on request.

The insert shortcut puts files into a page with a synthetic paste event. A reviewer may read that
as a second feature. It is the delivery step of the same workflow. The reviewer notes explain it.

## Permission justifications

Paste each text into the matching field of the Privacy tab. Remote code: **No, I am not using remote
code.**

| Permission | Justification |
|---|---|
| `activeTab` | Spool starts only when the user clicks the toolbar button or presses the shortcut. `activeTab` gives temporary access to that one tab, so the extension can take screenshots of its visible area and show its controls there. Spool has no host permissions and cannot access any other tab or site. |
| `scripting` | After the user starts a capture, Spool injects its own packaged scripts (the selection overlay, the scroll and measure logic, the result card) into the top frame of the active tab with `chrome.scripting.executeScript`. It loads no remote code. |
| `offscreen` | Reason BLOBS. The service worker cannot hold large image data or create blob URLs. A hidden offscreen document keeps the captured steps in memory, joins them into one image, builds the AI screenshots, and creates blob URLs for saving. It is created when needed and closed when idle. No image data is written to extension storage. |
| `storage` | Saves the user's settings (overlap, wait time, maximum length, AI screenshot size, save options, downloads folder name) in `chrome.storage.sync`, and three small counters in `chrome.storage.local` that limit how often Spool asks where to save and how often it shows a teaching message. No image data or page data is stored. |
| `downloads` | Saves the finished full image and AI screenshots to a "Spool" subfolder of the user's Downloads folder when the user has no save folder, or the browser has not allowed it right now. It downloads only blob URLs that the extension itself created, to a fixed relative path, and never a URL from a web page. It does this only after the user clicks Copy & save or Save. |
| `clipboardWrite` | After the user clicks Copy & save, Spool writes the finished full image to the clipboard. The extension's background worker needs this permission as a fallback when the page blocks clipboard writes. Spool never reads the clipboard. |

## Data use answers

- **Data collected:** Website content only. Do not tick personal communications, because a chat
  screenshot is still website content.
- **Certifications:** tick all three: the data is not sold, not used for unrelated purposes, and
  not used for creditworthiness or lending.
- **Why privacy policy is needed:** Google counts local handling of website content, so link
  [docs/privacy.md](../privacy.md). It carries the Limited Use statement.

## Reviewer test notes

> Open any long web page. Click the Spool toolbar button, or press Alt+Shift+S (Control+Shift+S on
> a Mac). The Welcome tab that opened on install asks where to save. Click "Save to Pictures >
> Screenshots" and approve the folder prompt, or click "Keep using Downloads". Back on the page,
> click a scrolling panel or drag a box, then click Scroll several times. Click Copy & save. A
> card at the bottom right confirms, the full image is on the clipboard, and files are saved. The
> settings page (right-click the icon, then Options) sets the overlap, the AI screenshot size and
> the folder. For a long capture, press Alt+Shift+V in another tab with a text field to insert
> the AI screenshots. The extension has no host permissions, no content scripts and no network
> access (Content Security Policy `connect-src 'none'`).

## Asset checklist

| Asset | Requirement | Status |
|---|---|---|
| Package | Zip with `manifest.json` at the root and a `version` higher than the last upload. `npm run package` builds it. | Per release |
| Store icon | 128 × 128 PNG. Chrome's guidance is 96 × 96 art with 16 px of transparent padding. `icons/icon-128.png` is full-bleed, so make a padded copy for this field if the dashboard rejects it. | `icons/icon-128.png` exists |
| Screenshots | At least 1 and up to 5. 1280 × 800 preferred (640 × 400 allowed). Square corners, no padding. | To make |
| Suggested screenshots | 1. The overlay selecting a panel. 2. The control bar mid-capture. 3. The toast after Copy & save. 4. The capture page, For AI. 5. The Welcome tab. All on a neutral page. | To make |
| Small promo tile | 440 × 280. Optional. | Skip |
| Marquee promo | 1400 × 560. Optional. | Skip |
| Video | Optional YouTube link. | Skip |
| Description | Required. Lead with the purpose, no keyword lists. | Above |
| Single purpose, permissions, remote code, data use | Privacy tab. | Above |
| Privacy policy URL | Publicly reachable. The repository must be public. | Above |
| Distribution | Unlisted, all regions. | Set in the dashboard |
| Contact email | Verified on the Account page. | Owner |
