# Readwise Save Translated Requirements

## Goal

Build a Chrome extension that saves the translated state of the current web page into Readwise Reader without writing custom parsers for individual sites.

## Current Product Direction

- The extension should save a translated page as a bilingual-enhanced Reader document by uploading rendered HTML.
- The extension should not attempt page-specific parsing, custom block filtering, or site-specific extraction logic.
- The extension should delegate document cleaning and parsing to Readwise whenever possible.
- The extension should avoid maintaining any custom parser logic for specific websites or layouts.
- The extension may offer a generic `article`-scope upload option, but it should only reuse an existing page `article` element and should not become a custom parser.
- The extension should present `article` scope as a lighter first try, not as a guaranteed cleaner result than whole-page HTML.
- The extension should preserve a path back to the original article URL.
- The extension should work with browser-side translation tools such as Kiss Translator, as long as the translated text is reflected in the page DOM.

## Functional Requirements

- Provide a Chrome extension implementation.
- Make left click on the extension action trigger the default article-only save immediately.
- Expose a right-click action menu entry that opens a more detailed extension page.
- Trigger fallback saves and diagnostics from the detailed page instead of the primary action click.
- Capture the current page as an HTML snapshot after translation has been applied.
- Provide an `article-only` HTML save path as the preferred button behavior.
- Provide a whole-page raw HTML save path as the explicit fallback button behavior.
- Use `should_clean_html: true` for both HTML save paths.
- Send the snapshot to Readwise Reader using the Reader save API.
- Use the original page URL as the initial source URL strategy unless real-world testing proves it collides with an existing Reader document.
- If Readwise reports that the original URL already exists, retry with a fragment-based URL such as `#rw-translated=<timestamp>` so the saved URL still opens the original page.
- Use a `[ZH] ` title prefix by default.
- Do not apply any default tags unless the user explicitly configures them.
- Add a top-level note that records the original URL and capture time.
- Show clear success or failure feedback after a left-click save attempt.
- Show the current page title and URL inside the detailed page.
- Show whether a Readwise token is configured.
- Show which capture mode is active.
- Show which HTML scope was used on the most recent save.
- Show the result of the most recent save attempt inside the detailed page.
- Show lightweight diagnostics from the last save attempt, including whether Readwise HTML cleaning was enabled.

## Configuration Requirements

- Store the Readwise access token locally inside the extension.
- Support a local JSON config file for the Readwise token and default metadata, so the unpacked extension can be configured without using the options page.
- Allow the title prefix to be changed.
- Allow capture mode to be changed between `html` and any experimental fallback modes.
- Allow default tags to be changed.

## Testing Requirements

- When running experiments against the real Reader account, test artifacts should be deleted after verification.
- Test artifacts should not be left in `archive`.

## Open Questions

- Does every target translation tool write translated text back into the live DOM, or do some tools only visually overlay translations?
- Will Readwise always allow duplicate documents when HTML is uploaded directly, or is URL collision behavior different across save paths?
- Should the extension eventually support an alternate URL strategy such as `#fragment`, `?query`, or a redirect URL if original URLs collide in production?
- If a document already exists in Reader under the same URL, does deleting it first materially improve Readwise's cleaning quality for a new raw HTML upload?
