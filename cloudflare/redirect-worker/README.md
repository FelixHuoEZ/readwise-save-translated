# Cloudflare Redirect Worker

This Worker turns a signed fallback URL into a normal redirect back to the original article.

## Route

- Custom domain: `https://go.example.com`
- Redirect path: `/open`

Example generated URL:

```text
https://go.example.com/open?u=...&n=...&s=...&v=v1
```

## Secret

Set the signing secret before deploy:

```bash
npx wrangler secret put REDIRECT_SIGNING_SECRET --config cloudflare/redirect-worker/wrangler.jsonc
```

Use the same secret value in the extension settings as `Redirect signing secret`.

## Deploy

```bash
npx wrangler login
npx wrangler deploy --config cloudflare/redirect-worker/wrangler.jsonc
```

## Extension Settings

After deploy, set:

- `Redirect base URL`: `https://go.example.com`
- `Redirect signing secret`: the same value used for `REDIRECT_SIGNING_SECRET`

Then reload the extension.
