# Privacy Policy

## Summary

Readwise Save Translated stores your Readwise access token locally and sends page content to Readwise only when you explicitly ask it to save the current page.

## Data the Extension Handles

The extension may handle the following data:

- Your Readwise access token
- The current page URL
- The current page HTML snapshot
- Visible page title, translated title, author, and published date when available
- A synthetic fallback URL when you choose the fallback save action

## How Data Is Used

The extension uses this data only to:

- save the current translated page to Readwise Reader
- preserve translated content when the default save path fails
- show save status and debugging details inside the extension

## Where Data Is Stored

- Your Readwise token and extension settings are stored locally in Chrome extension storage.
- If you use `config.local.json`, that file stays on your machine.
- The extension does not operate its own backend service.

## Where Data Is Sent

The extension sends save requests to Readwise at `https://readwise.io/`.

When you trigger a save, the extension may send:

- page URL
- HTML snapshot
- title
- author
- published date
- optional tags if you configured them

No analytics, advertising, or unrelated data sharing is included.

## User Control

- The extension reads page content only after an explicit user action.
- You can remove the token from the extension settings at any time.
- You can uninstall the extension at any time.

## Third Parties

The extension shares data only with Readwise to perform the save operation requested by the user.

## Contact

Use the repository issue tracker for support once this project is published.
