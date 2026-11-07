{{notes}}

---

## Install or update

1. Download `{{zip}}` from the assets below and unzip it into a folder you will keep, for example `Documents/Spool`. To update, unzip over the same folder.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick that folder. After an update, click **Reload** on the Spool card instead.

A Chrome Web Store install needs none of this. It updates itself.

Step-by-step guides: [install](https://github.com/{{repo}}/blob/{{tag}}/docs/guides/install.md), [update](https://github.com/{{repo}}/blob/{{tag}}/docs/guides/update.md), [troubleshooting](https://github.com/{{repo}}/blob/{{tag}}/docs/guides/troubleshooting.md).

## Verify the download

SHA-256 of `{{zip}}`: `{{sha256}}`

```text
macOS / Linux   shasum -a 256 -c {{zip}}.sha256
Windows         Get-FileHash .\{{zip}} -Algorithm SHA256
Build proof     gh attestation verify {{zip}} --repo {{repo}}
Release proof   gh release verify {{tag}} --repo {{repo}}
```

## Permissions

{{permissions}}

{{compare}}
