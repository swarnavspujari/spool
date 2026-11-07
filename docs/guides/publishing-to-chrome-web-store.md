# Publishing Spool to the Chrome Web Store

This guide is for the owner. Only the owner can do the account and identity steps. Everything after
the first upload can run from CI.

Spool goes in the store as an **Unlisted** item. Unlisted means the item does not appear in store
search or categories, and anyone with the item's URL can install it. It follows the same policies and the
same review as a public item. Friends click one link, press **Add to Chrome**, and get updates by
themselves within a few hours. The GitHub release zip stays as the fallback for people who cannot
or will not use the store.

Status of the automation: the upload script `.github/scripts/cws-upload.mjs` has unit tests for its
pure parts, but it has **not been run against the live Chrome Web Store API**. The release job that
calls it is off until the repository variable `CWS_ENABLED` is `true`. Expect the first real run to
be the test, and keep the manual dashboard upload as the way out.

## 1. Account and identity (owner only)

1. **Choose the Google account** and turn on **2-Step Verification**. Google requires it before you
   publish or update an extension.
2. **Pick a dedicated developer email.** The developer email is set at registration and **cannot be
   changed later**. Use a new address that you check often, not your personal one. If you lose
   access to it, the only fix is a new account and an item transfer.
3. **Register** in the [Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole).
   Accept the agreement and pay the one-time registration fee. It is about USD 5 and covers all
   your items with no yearly renewal, but Google's own page gives no amount, so confirm it at
   checkout. Use a card that allows international online payments.
4. **Verify a contact email** on the Account page. This one is shown on the item and you can edit
   it later. Use an alias, not your private address.
5. **Set the publisher name.** It is free text, shown as "Offered by". Use "Spool" or a handle.
6. **Declare trader or non-trader.** This is an EU Digital Services Act requirement for every
   developer. A trader's address and phone number show publicly at the bottom of the listing. A
   non-trader gets only a notice that EU consumer protection rights may not apply. A free tool
   shared with friends is normally the non-trader case, but it is a legal question and you declare
   it yourself. A non-trader gives no address and no phone number.

## 2. First upload (owner only)

The API cannot create an item or set its visibility, so the first upload is by hand.

1. Run `npm run check && npm run package`. This builds `dist/spool-<version>.zip`.
2. In the dashboard click **Add new item** and upload the zip. The manifest must not contain a
   `key`. The policy check forbids it.
3. Fill the **Store listing** tab from [docs/store/listing.md](../store/listing.md): name, summary,
   description, category (Productivity), language (English), screenshots and the icon.
4. Fill the **Privacy** tab from the same file:
   - Single purpose statement.
   - One justification for each of the six permissions.
   - Remote code: **No, I am not using remote code.**
   - Data use: tick **Website content** only. Tick all three certifications (not sold, not used
     for unrelated purposes, not used for creditworthiness).
   - Privacy policy URL: `https://github.com/swarnavspujari/spool/blob/main/docs/privacy.md`. It
     must be publicly reachable, so the repository must be public first.
5. On the **Distribution** tab choose visibility **Unlisted** and regions **All regions**.
6. Add the reviewer test notes from the listing file, then **Submit for review**.

Review usually takes days and can take weeks. A new developer account and a new item are named
triggers for a longer review, so start early. Spool has no host permissions, which removes the
biggest trigger for an in-depth review. `downloads` and `clipboardWrite` show install warnings
("Manage your downloads", "Modify data you copy and paste"), so write their justifications with
care. A rejection leaves a live version untouched and does not notify users. Appeal from the item
page.

When the item is approved:

1. Write down the **extension ID** (32 letters) and the **publisher ID** from the Account page.
2. Open the item's URL from a second browser profile and install it. Then try Brave, Edge and
   Comet once each. Brave and Comet behavior with an unlisted store item is not verified.
3. Share the URL with the people who should have Spool.

The store item has its own extension ID. It differs from the ID of any unpacked copy, including
yours, so settings do not carry over from a zip install.

## 3. Automate uploads from CI

Do this after the first item is live. It needs a Google Cloud project and a GitHub environment.

### In Google Cloud and the dashboard

1. Create a Google Cloud project. Enable the **Chrome Web Store API** in it.
2. Create a **service account** in that project. Create a JSON key for it and download the key.
3. In the store dashboard, open **Account** and add the service account's email address. A
   publisher can have only one service account.

### In GitHub

1. Create an environment named `chrome-web-store` under Settings, Environments. Optionally add
   yourself as a required reviewer, if your plan allows it, so each upload waits for you.
2. Add the environment secret `CWS_SERVICE_ACCOUNT_KEY` with the complete text of the JSON key. The
   job writes it to a private temporary file, passes only the file path to the script, and deletes
   the file when it ends. The script never prints the key or the access token.
3. Add the repository variables `CWS_PUBLISHER_ID` and `CWS_EXTENSION_ID`.
4. Optionally add `CWS_PUBLISH_TYPE`. `STAGED_PUBLISH` is the default. The store approves the
   version, then holds it until you press **Publish** in the dashboard, and it reverts to a draft
   after 30 days. `DEFAULT_PUBLISH` publishes on approval. Use `STAGED_PUBLISH` for the first real
   run, because it gives you a human gate.
5. Add the repository variable `CWS_ENABLED` with the value `true`. Nothing in the repository sets
   it for you.

The key is a long-lived secret. Keep it only in the environment secret, never in a file or a
commit, and rotate it once a year. If it leaks, delete the key in Google Cloud at once.

### What the job does

`.github/workflows/release.yml` runs the `store` job after the `publish` job succeeded, for a tag
push. It downloads the same release artifact, so the store gets the same bytes as the GitHub
release. `.github/scripts/cws-upload.mjs` then:

1. Signs a token request with the service account key (RS256) and exchanges it for an access
   token with the `chromewebstore` scope.
2. Uploads the zip to `upload/v2/publishers/<id>/items/<id>:upload`. If the upload is still in
   progress, it polls `:fetchStatus` every 15 seconds, up to 20 times.
3. Calls `:publish` with the publish type, and stops with an error if the item is rejected or
   cancelled.

The script uses Node built-ins only. It targets the v2 API. The older v1 API stopped on 2026-10-15,
so do not swap in a tool that still uses it. v2 cannot create items, change visibility or run a
percentage rollout, which needs more than 10,000 weekly users.

If the job fails, upload by hand: dashboard, your item, **Package**, **Upload new package**, then
**Submit for review**.

## 4. Each release

1. Release as usual. See [releasing.md](releasing.md). The `version` in `manifest.json` must be
   higher than the last upload, or the upload fails.
2. Wait for the review email. It takes hours to days. With `STAGED_PUBLISH`, press **Publish** in
   the dashboard when you get it.
3. Users update by themselves. Chrome checks every few hours. For a critical fix, tell people to
   restart their browser.

Every fix is a new submission and a new review. You cannot skip review.

Do not add a permission after launch unless a feature needs it. If an update adds a permission with
a warning, Chrome disables the extension for each user until they accept it. `activeTab`,
`scripting`, `offscreen` and `storage` show no warning. `clipboardWrite` and `downloads` do. A new
permission also needs a security review. See the "Add a permission" section of
[development.md](../development.md#add-a-permission).

## 5. Listing rules to keep

- **Name no AI company or product in the listing**, in the name, the icon, the screenshots or the
  description. Google's listing rules forbid claiming endorsement or affiliation, and a list of
  brands without added value counts as keyword spam. Say "your AI" or "AI chat tools". The listing
  file says that Spool is independent. Take screenshots of a neutral page, not of a branded chat.
- Describe the insert shortcut honestly. It puts files into a page with a synthetic paste event.
  The listing file explains it as part of the one purpose, delivering the capture.
- Names are not unique in the store, and other items already use "Spool". Say "Spool (scrolling
  screenshot)" in the summary to avoid confusion. If you rename the item, change the manifest
  `name` and the docs in one commit.
- The privacy policy must match the code. Update [docs/privacy.md](../privacy.md) whenever the data
  Spool handles changes, and update the Privacy tab to match.

## 6. Each year

About 30 minutes. Confirm that 2-Step Verification is on and that you still control the developer
email. Check that the service account key and the GitHub secrets still work, by running a dry
upload. Read the dashboard for policy warnings and re-attest privacy practices if Google asks. You
renew nothing.

## 7. Other browsers

Chrome, Brave, Edge and Comet can install Chrome Web Store items. Edge shows a note that Microsoft
does not verify extensions from another store. Spool does not need an Edge listing. An Edge Add-ons
listing is free but is a second account and a second review, so skip it unless people ask. Arc is
being shut down, so do not promise it.
