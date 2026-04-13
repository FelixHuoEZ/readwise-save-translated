# Readwise Save Translated

Save the translated version of the current page to Readwise Reader.

This Chrome extension is built for a specific workflow: you open an article, translate it in the browser, then save the translated DOM state instead of letting Readwise fetch the original page URL and losing the translation.

## What It Does

- Saves the current translated page HTML to Readwise Reader.
- Preserves translated content when the translation plugin writes text back into the DOM.
- Uses Readwise's own `should_clean_html` pipeline instead of a site-specific parser.
- Keeps the default save path on the original article URL.
- Adds a fallback mode for pages that Readwise cleans back to English.

## How It Works

### Default save

- Left click the extension icon.
- The extension saves the current page with the original article URL.
- This keeps Readwise's native source-link behavior.

### Fallback mode

- Right click the extension icon.
- Choose `Save with fallback mode`.
- If you configured a custom fallback mode, the extension saves an `article`-scoped HTML snapshot with that fallback source.
- Otherwise it falls back to a placeholder local URL.
- The saved Reader document includes an `Open original article` link at the top.

Use the fallback only when the default save path collapses the translated content back to English.

## Why This Exists

Readwise can save rendered browser content, but in practice the final result can vary by page and by URL handling. This extension exists to preserve the translated state of the page with the least possible custom logic:

- no site-specific parser
- no per-site extraction rules
- no block-level cleanup pipeline maintained locally

## Features

- Action-first UX
  - Left click saves immediately.
  - Right click opens secondary actions.
- Two save strategies
  - Original URL default
  - Fallback mode
- Bilingual title support
  - If the page has visible English and translated Chinese headings, the saved title can include both.
- Metadata extraction
  - Tries to send author and published date from generic sources such as meta tags, JSON-LD, and `time[datetime]`.
- Per-tab save state icon
  - The toolbar icon keeps the success or error badge for the current tab until that tab refreshes, navigates, or closes.
- Details page
  - Shows the last save result, existing-document detection, links, and debug info.

## Install

### Chrome Web Store

Install from the Chrome Web Store:

- [Readwise Save Translated](https://chromewebstore.google.com/detail/readwise-save-translated/dldfhloleilmmicopaieohigjkkhnleg)

### GitHub Releases

You can install the current release manually from GitHub Releases:

- Download the latest `.crx` from the [Releases page](https://github.com/FelixHuoEZ/readwise-save-translated/releases)
- Open `chrome://extensions`
- Enable Developer mode
- Drag the `.crx` file onto the page and confirm the install

If Chrome rejects the `.crx` install, use the release `.zip` instead:

- Download the latest `.zip` from the [Releases page](https://github.com/FelixHuoEZ/readwise-save-translated/releases)
- Unzip it locally
- Open `chrome://extensions`
- Enable Developer mode
- Click `Load unpacked`
- Select the extracted folder

### Local development

1. Clone this repository.
2. Open `chrome://extensions`.
3. Enable Developer mode.
4. Click `Load unpacked`.
5. Select this project directory.

## Configure

You need a Readwise access token from [readwise.io/access_token](https://readwise.io/access_token).

You can configure the extension in either of these ways:

- Open the extension settings page and save the token there.
- Edit `config.local.json` locally, then reload the unpacked extension.

Example `config.local.json`:

```json
{
  "readwiseToken": "YOUR_TOKEN_HERE",
  "titlePrefix": "",
  "defaultTags": [],
  "captureMode": "html",
  "redirectMode": "synthetic",
  "redirectConfigs": {
    "local-signing": {
      "redirectBaseUrl": "",
      "redirectSigningSecret": ""
    },
    "service-signing": {
      "redirectServiceUrl": ""
    },
    "direct-redirect-unsafe": {
      "redirectBaseUrl": ""
    }
  }
}
```

`config.local.json` is ignored by Git.

The Settings UI uses user-facing labels such as `Placeholder source URL (default)`.
`config.local.json` uses internal keys instead. For example, the Settings label `Placeholder source URL (default)` maps to `"redirectMode": "synthetic"`.

The extension keeps each fallback mode's settings separate. Switching modes in Settings does not erase the values you already entered for the other modes.

## Use

### Fast path

1. Open a page.
2. Let your translation plugin finish.
3. Left click the extension icon.
4. Check the icon state on that tab.

### If the saved Reader document becomes English-only

1. Right click the extension icon.
2. Choose `Save with fallback mode`.
3. Open the new Reader document.
4. Use the `Open original article` link at the top when you need to jump back to the source page.

## Optional Redirect Modes

By default, fallback saves use a placeholder local URL.

If you want a cleaner source link that can jump back to the original page, you can switch the fallback mode in Settings:

- `Placeholder source URL (default)`
  - No redirect setup
  - Fallback uses a placeholder Reader source URL
  - Use the in-document original link when you need the real article URL
- `Extension-built redirect`
  - Set `Redirect base URL`
  - Set `Redirect signing secret`
  - The extension builds the redirect URL locally
- `Service-built redirect`
  - Set `Redirect service URL`
  - Your service returns the redirect URL
- `Direct redirect (unsafe)`
  - Set `Redirect base URL`
  - No secret
  - Your redirect endpoint must accept `/open?u=...` without signature checks
  - Your domain becomes an open redirect

## Cloudflare Worker for Local Signing

This repository includes an optional Cloudflare Worker at [cloudflare/redirect-worker](./cloudflare/redirect-worker).

Use this setup only if you want the `Extension-built redirect` mode to use your own domain instead of the default placeholder fallback.

Example target domain:

- `https://go.example.com`

Recommended rollout:

1. Pick a subdomain such as `go.example.com`.
2. Open [`cloudflare/redirect-worker/wrangler.jsonc`](./cloudflare/redirect-worker/wrangler.jsonc).
3. Change the custom-domain route pattern to your own subdomain.
4. Create a Cloudflare API token using the `Edit Cloudflare Workers` template.
5. Create a local `.cloudflare.env.local` file from [`.cloudflare.env.local.example`](./.cloudflare.env.local.example).
6. Fill in:
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
   - `REDIRECT_SIGNING_SECRET`
   - `REDIRECT_BASE_URL=https://go.example.com`
7. Upload the Worker secret:

```bash
npx wrangler secret put REDIRECT_SIGNING_SECRET --config cloudflare/redirect-worker/wrangler.jsonc
```

8. Deploy the Worker:

```bash
npm run deploy:redirect-worker
```

9. Open the extension settings page.
10. In extension Settings, switch the fallback mode to `Extension-built redirect`.
11. Set `Redirect base URL` to your deployed domain.
12. Set the same `Redirect signing secret` in the extension settings.
13. Reload the extension.

The signing secret is intentionally local-only. Do not bundle it into a public extension package.

## Privacy

- The extension stores your Readwise token locally.
- It reads page content only when you explicitly trigger a save.
- It sends the saved HTML snapshot and related metadata to Readwise.
- It does not include analytics, ads, or third-party tracking.

See [PRIVACY.md](./PRIVACY.md) for the full policy.

## Development

Install dependencies:

```bash
npm install
```

Useful commands:

```bash
npm run test:e2e-save
```

## Project Files

- [`manifest.json`](./manifest.json): Chrome extension manifest
- [`background.js`](./background.js): save flow, API calls, menu actions, icon state
- [`details.html`](./details.html): details page UI
- [`options.html`](./options.html): settings page
- [`cloudflare/redirect-worker`](./cloudflare/redirect-worker): optional self-hosted Worker for Extension-built redirect mode
- [`docs/requirements.md`](./docs/requirements.md): product requirements in Chinese
- [`docs/cloudflare-redirect-setup.md`](./docs/cloudflare-redirect-setup.md): Cloudflare redirect service setup and rollout notes

## Known Limits

- If the translation plugin only paints translated text visually and does not write it into the DOM, the extension cannot save the translated content reliably.
- Some pages still depend on how Readwise handles URL canonicalization and HTML cleaning.
- The redirect service is optional. If it is not configured, fallback saves use a placeholder local URL plus an in-document original-article link.
