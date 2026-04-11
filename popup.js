const pageTitleNode = document.querySelector("#page-title");
const pageUrlNode = document.querySelector("#page-url");
const tokenPill = document.querySelector("#token-pill");
const pagePill = document.querySelector("#page-pill");
const articleSaveButton = document.querySelector("#article-save-button");
const wholePageButton = document.querySelector("#whole-page-button");
const settingsButton = document.querySelector("#settings-button");
const saveHintNode = document.querySelector("#save-hint");
const lastSaveNode = document.querySelector("#last-save");
const actionsSection = document.querySelector("#actions-section");
const resultSection = document.querySelector("#result-section");
const shellNode = document.querySelector(".shell");
const versionFooterNode = document.querySelector("#version-footer");
const targetTabId = parseTargetTabId();
const EXTENSION_VERSION = chrome.runtime.getManifest().version;
const actionButtonMarkup = new Map([
  [articleSaveButton, articleSaveButton.innerHTML],
  [wholePageButton, wholePageButton.innerHTML]
]);
let currentLastSaveResult = null;

settingsButton.addEventListener("click", async () => {
  await chrome.runtime.openOptionsPage();
});

articleSaveButton.addEventListener("click", async () => {
  await runSave({
    button: articleSaveButton,
    loadingLabel: "Saving…",
    successHint: "Saved to Readwise with the configured fallback mode.",
    hint: "Saving with your configured fallback mode so Readwise keeps the translated HTML, then adding an original-article link into the saved document.",
    message: {
      type: "save-active-tab",
      tabId: targetTabId,
      captureMode: "html",
      forceReaderClean: true,
      htmlScope: "article-only",
      useFallbackSource: true
    }
  });
});

wholePageButton.addEventListener("click", async () => {
  await runSave({
    button: wholePageButton,
    loadingLabel: "Saving…",
    successHint: "Saved to Readwise with the default source URL path.",
    hint: "Saving with the original page URL, which keeps Reader's native source link behavior.",
    message: {
      type: "save-active-tab",
      tabId: targetTabId,
      captureMode: "html",
      forceReaderClean: true,
      htmlScope: "whole-page",
      useFallbackSource: false
    }
  });
});

void loadState();
renderVersionFooter();

async function loadState() {
  const response = await chrome.runtime.sendMessage({
    type: "get-popup-state",
    tabId: targetTabId
  });

  if (!response?.ok) {
    renderFailureState(response?.error ?? "Unable to load details state.");
    return;
  }

  const { activeTab, config, lastSaveResult } = response.state;
  currentLastSaveResult = lastSaveResult ?? null;
  renderActiveTab(activeTab, config);
  renderLastSave(lastSaveResult);
}

function renderActiveTab(activeTab, config) {
  pageTitleNode.textContent = activeTab?.title || "Original tab unavailable";
  pageUrlNode.textContent = activeTab?.url || "This details page is no longer attached to an open article tab.";

  setPill(tokenPill, config.hasToken ? "Token ready" : "Token missing", config.hasToken ? "ok" : "warn");
  if (config.hasToken && config.tokenSource === "file") {
    tokenPill.textContent = "Token from file";
  }
  if (config.hasToken && config.tokenSource === "extension") {
    tokenPill.textContent = "Token from extension";
  }

  setPill(
    pagePill,
    activeTab?.saveable ? "Page can be saved" : "Page not saveable",
    activeTab?.saveable ? "ok" : "warn"
  );

  setActionButtonsDisabled(!config.hasToken || !activeTab?.saveable);

  if (!config.hasToken) {
    saveHintNode.textContent = "Add your Readwise token before saving.";
    return;
  }

  if (!activeTab?.saveable) {
    saveHintNode.textContent = "Open this from the extension on a normal http(s) article tab.";
    return;
  }

  if (config.redirectMode === "local-signing" && config.redirectBaseUrl && config.hasRedirectSigningSecret) {
    saveHintNode.textContent = "Default keeps the original URL. Fallback builds the redirect link inside the extension.";
    return;
  }

  if (config.redirectMode === "service-signing" && config.redirectServiceUrl) {
    saveHintNode.textContent = "Default keeps the original URL. Fallback asks your service to build the redirect link.";
    return;
  }

  if (config.redirectMode === "direct-redirect-unsafe" && config.redirectBaseUrl) {
    saveHintNode.textContent = "Default keeps the original URL. Fallback sends the destination directly to your redirect domain.";
    return;
  }

  saveHintNode.textContent = "Default keeps the original URL. Fallback switches to a generated source only if needed.";
}

function renderLastSave(lastSaveResult) {
  syncDetailsLayout(lastSaveResult);

  if (!lastSaveResult) {
    lastSaveNode.innerHTML = '<p class="empty">No save has been attempted from this extension yet.</p>';
    return;
  }

  const rows = [];
  const technicalRows = [];

  technicalRows.push(renderRow("Saved at", formatTime(lastSaveResult.savedAt)));
  technicalRows.push(renderRow("Original URL", escapeHtml(lastSaveResult.originalUrl || "—")));

  if (lastSaveResult.readerSourceUrl) {
    technicalRows.push(renderRow("Reader source URL", escapeHtml(lastSaveResult.readerSourceUrl)));
  }

  if (lastSaveResult.sourceStrategy || lastSaveResult.status === "success") {
    technicalRows.push(renderRow("Source strategy", escapeHtml(formatSourceStrategy(lastSaveResult.sourceStrategy))));
  }

  if (lastSaveResult.redirectMode) {
    technicalRows.push(renderRow("Configured redirect mode", escapeHtml(formatRedirectMode(lastSaveResult.redirectMode))));
  }

  if (lastSaveResult.existingDocumentDetected) {
    technicalRows.push(renderRow("Existing Reader doc", "This URL already existed in Reader."));
  }

  if (lastSaveResult.existingDocumentUrl) {
    technicalRows.push(
      renderRow(
        "Existing Reader link",
        `<a href="${escapeAttribute(lastSaveResult.existingDocumentUrl)}" target="_blank" rel="noreferrer">${escapeHtml(lastSaveResult.existingDocumentUrl)}</a>`
      )
    );
  }

  if (lastSaveResult.pageTitle) {
    technicalRows.push(renderRow("Resolved title", escapeHtml(lastSaveResult.pageTitle)));
  }

  if (lastSaveResult.parserTitle) {
    technicalRows.push(renderRow("Parser title", escapeHtml(lastSaveResult.parserTitle)));
  }

  if (lastSaveResult.ingestTitle) {
    technicalRows.push(renderRow("Ingest title", escapeHtml(lastSaveResult.ingestTitle)));
  }

  if (lastSaveResult.displayTitle) {
    technicalRows.push(renderRow("Display title", escapeHtml(lastSaveResult.displayTitle)));
  }

  if (lastSaveResult.originalTitle) {
    technicalRows.push(renderRow("Original title", escapeHtml(lastSaveResult.originalTitle)));
  }

  if (lastSaveResult.translatedTitle) {
    technicalRows.push(renderRow("Translated title", escapeHtml(lastSaveResult.translatedTitle)));
  }

  if (lastSaveResult.author) {
    technicalRows.push(renderRow("Author", escapeHtml(lastSaveResult.author)));
  }

  if (lastSaveResult.publishedDate) {
    technicalRows.push(renderRow("Published", escapeHtml(formatTime(lastSaveResult.publishedDate))));
  }

  if (lastSaveResult.captureMode) {
    technicalRows.push(renderRow("Capture mode", escapeHtml(lastSaveResult.captureMode)));
  }

  if (lastSaveResult.htmlScope) {
    technicalRows.push(renderRow("HTML scope", escapeHtml(lastSaveResult.htmlScope)));
  }

  if (typeof lastSaveResult.readerCleanedHtml === "boolean") {
    technicalRows.push(renderRow("Reader clean HTML", lastSaveResult.readerCleanedHtml ? "Enabled" : "Disabled"));
  }

  if (lastSaveResult.titleUpdateApplied) {
    technicalRows.push(renderRow("Title update", "Applied after save"));
  } else if (lastSaveResult.titleUpdateError) {
    technicalRows.push(renderRow("Title update", escapeHtml(lastSaveResult.titleUpdateError)));
  }

  if (lastSaveResult.contentRootSelector) {
    technicalRows.push(renderRow("Content root", escapeHtml(lastSaveResult.contentRootSelector)));
  }

  if (lastSaveResult.articleSelector) {
    technicalRows.push(renderRow("Article root", escapeHtml(lastSaveResult.articleSelector)));
  }

  if (typeof lastSaveResult.detectedCjkCount === "number") {
    technicalRows.push(renderRow("Detected CJK", String(lastSaveResult.detectedCjkCount)));
  }

  if (typeof lastSaveResult.contentBlockCount === "number") {
    technicalRows.push(renderRow("Blocks kept", String(lastSaveResult.contentBlockCount)));
  }

  if (lastSaveResult.previewText) {
    technicalRows.push(renderRow("Preview", escapeHtml(lastSaveResult.previewText)));
  }

  if (lastSaveResult.usedFallbackUrl) {
    technicalRows.push(renderRow("URL fallback", "Fragment-based retry was used."));
  }

  if (lastSaveResult.error) {
    technicalRows.push(renderRow("Error", escapeHtml(lastSaveResult.error)));
  }

  const readerLink = lastSaveResult.readerDocumentUrl
    ? `<a class="result-link" href="${escapeAttribute(lastSaveResult.readerDocumentUrl)}" target="_blank" rel="noreferrer">Open Reader document</a>`
    : "";
  const statusClass = lastSaveResult.status === "success" ? "success" : "error";
  const scopeBadge = lastSaveResult.htmlScope
    ? `<span class="scope-badge">${escapeHtml(lastSaveResult.htmlScope)}</span>`
    : "";
  const fallbackBadge = lastSaveResult.usedFallbackUrl
    ? '<span class="scope-badge">url fallback</span>'
    : "";
  const sourceBadge = lastSaveResult.sourceStrategy && lastSaveResult.sourceStrategy !== "original-url"
    ? `<span class="scope-badge">${escapeHtml(formatSourceStrategyBadge(lastSaveResult.sourceStrategy))}</span>`
    : "";
  const existingBadge = lastSaveResult.existingDocumentDetected
    ? '<span class="scope-badge">existing doc</span>'
    : "";
  const debugText = buildDebugText(lastSaveResult);
  const detailsOpen = lastSaveResult.status === "error" ? " open" : "";
  const copyDebugButtonMarkup = `
    <div class="details-actions">
      <button class="ghost-button small" type="button" data-copy-debug>Copy debug</button>
    </div>
  `;
  const factCards = buildFactGrid([
    {
      key: "Source",
      value: lastSaveResult.status === "success"
        ? formatSourceStrategy(lastSaveResult.sourceStrategy)
        : "Not saved"
    },
    {
      key: "Title",
      value: lastSaveResult.displayTitle || lastSaveResult.pageTitle || "—"
    },
    {
      key: "Author",
      value: lastSaveResult.author || "—"
    },
    {
      key: "Published",
      value: formatTime(lastSaveResult.publishedDate)
    }
  ]);

  lastSaveNode.innerHTML = `
    <div class="result-summary">
      <div class="status-line">
        <span class="status-badge ${statusClass}">${escapeHtml(formatStatus(lastSaveResult))}</span>
        ${scopeBadge}
        ${sourceBadge}
        ${fallbackBadge}
        ${existingBadge}
      </div>
      ${readerLink}
      <div class="result-meta">Saved ${escapeHtml(formatTime(lastSaveResult.savedAt))}</div>
      <div class="fact-grid">${factCards}</div>
      <details${detailsOpen}>
        <summary>Technical details</summary>
        <p class="details-note">Open this only when you need save metadata, source strategy, or parsing diagnostics.</p>
        <div class="result-grid">${technicalRows.join("")}</div>
        ${copyDebugButtonMarkup}
        <details>
          <summary>Raw debug dump</summary>
          <pre class="debug-block">${escapeHtml(debugText)}</pre>
        </details>
      </details>
    </div>
  `;

  const copyButton = lastSaveNode.querySelector("[data-copy-debug]");
  if (copyButton) {
    copyButton.addEventListener("click", async () => {
      await copyDebugText(copyButton);
    });
  }
}

function renderFailureState(message) {
  pageTitleNode.textContent = "Popup state unavailable";
  pageUrlNode.textContent = message;
  setPill(tokenPill, "State error", "error");
  setPill(pagePill, "State error", "error");
  setActionButtonsDisabled(true);
  syncDetailsLayout(null);
  saveHintNode.textContent = message;
  lastSaveNode.innerHTML = '<p class="empty">Refresh the details page and try again.</p>';
}

function syncDetailsLayout(lastSaveResult) {
  if (!shellNode || !actionsSection || !resultSection) {
    return;
  }

  const hasLastSaveResult = Boolean(lastSaveResult);
  const shouldShowActions = !hasLastSaveResult || lastSaveResult.status === "error";

  actionsSection.hidden = !shouldShowActions;

  if (!hasLastSaveResult) {
    shellNode.insertBefore(actionsSection, resultSection);
    return;
  }

  if (shouldShowActions) {
    shellNode.insertBefore(actionsSection, resultSection);
    return;
  }

  shellNode.insertBefore(resultSection, actionsSection);
}

async function copyDebugText(button) {
  const debugText = buildDebugText(currentLastSaveResult);
  if (!debugText) {
    saveHintNode.textContent = "No debug info is available yet.";
    return;
  }

  try {
    await navigator.clipboard.writeText(debugText);
    const previousText = button.textContent;
    button.textContent = "Copied";
    window.setTimeout(() => {
      button.textContent = previousText;
    }, 1500);
  } catch {
    saveHintNode.textContent = "Copy failed. Select the text manually from the details page.";
  }
}

function setActionButtonsDisabled(disabled) {
  articleSaveButton.disabled = disabled;
  wholePageButton.disabled = disabled;
}

function buildDebugText(lastSaveResult) {
  if (!lastSaveResult) {
    return "";
  }

  const lines = [
    `extensionVersion: ${EXTENSION_VERSION}`,
    `status: ${lastSaveResult.status || ""}`,
    `savedAt: ${lastSaveResult.savedAt || ""}`,
    `originalUrl: ${lastSaveResult.originalUrl || ""}`,
    `readerDocumentUrl: ${lastSaveResult.readerDocumentUrl || ""}`,
    `readerSourceUrl: ${lastSaveResult.readerSourceUrl || ""}`,
    `redirectMode: ${lastSaveResult.redirectMode || ""}`,
    `sourceStrategy: ${lastSaveResult.sourceStrategy || ""}`,
    `usedSyntheticUrl: ${String(lastSaveResult.usedSyntheticUrl ?? false)}`,
    `usedRedirectUrl: ${String(lastSaveResult.usedRedirectUrl ?? false)}`,
    `existingDocumentDetected: ${String(lastSaveResult.existingDocumentDetected ?? false)}`,
    `existingDocumentUrl: ${lastSaveResult.existingDocumentUrl || ""}`,
    `pageTitle: ${lastSaveResult.pageTitle || ""}`,
    `parserTitle: ${lastSaveResult.parserTitle || ""}`,
    `ingestTitle: ${lastSaveResult.ingestTitle || ""}`,
    `displayTitle: ${lastSaveResult.displayTitle || ""}`,
    `originalTitle: ${lastSaveResult.originalTitle || ""}`,
    `translatedTitle: ${lastSaveResult.translatedTitle || ""}`,
    `author: ${lastSaveResult.author || ""}`,
    `publishedDate: ${lastSaveResult.publishedDate || ""}`,
    `captureMode: ${lastSaveResult.captureMode || ""}`,
    `htmlScope: ${lastSaveResult.htmlScope || ""}`,
    `readerCleanedHtml: ${String(lastSaveResult.readerCleanedHtml)}`,
    `titleUpdateApplied: ${String(lastSaveResult.titleUpdateApplied ?? false)}`,
    `titleUpdateError: ${lastSaveResult.titleUpdateError || ""}`,
    `contentRootSelector: ${lastSaveResult.contentRootSelector || ""}`,
    `articleSelector: ${lastSaveResult.articleSelector || ""}`,
    `contentBlockCount: ${String(lastSaveResult.contentBlockCount ?? "")}`,
    `detectedCjkCount: ${String(lastSaveResult.detectedCjkCount ?? "")}`,
    `usedFallbackUrl: ${String(lastSaveResult.usedFallbackUrl ?? false)}`,
    `previewText: ${lastSaveResult.previewText || ""}`
  ];

  if (lastSaveResult.error) {
    lines.push(`error: ${lastSaveResult.error}`);
  }

  return lines.join("\n");
}

function parseTargetTabId() {
  const params = new URLSearchParams(window.location.search);
  const value = params.get("tabId");
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function setPill(node, text, state) {
  node.textContent = text;
  node.dataset.state = state;
}

function formatStatus(result) {
  if (result.status === "success") {
    switch (result.sourceStrategy) {
      case "local-signing":
        return "Saved with extension-built redirect";
      case "service-signing":
        return "Saved with service-built redirect";
      case "direct-redirect-unsafe":
        return "Saved with direct redirect";
      case "synthetic":
        return "Saved with placeholder source";
    }

    if (result.existingDocumentDetected) {
      return "Saved with existing Reader doc";
    }

    return result.usedFallbackUrl ? "Saved with fallback URL" : "Saved successfully";
  }

  return "Save failed";
}

function formatSourceStrategy(strategy) {
  switch (strategy) {
    case "local-signing":
      return "Extension-built redirect";
    case "service-signing":
      return "Service-built redirect";
    case "direct-redirect-unsafe":
      return "Direct redirect (unsafe)";
    case "synthetic":
      return "Placeholder source URL";
    default:
      return "Original URL";
  }
}

function formatSourceStrategyBadge(strategy) {
  switch (strategy) {
    case "local-signing":
      return "extension-built";
    case "service-signing":
      return "service-built";
    case "direct-redirect-unsafe":
      return "direct redirect";
    case "synthetic":
      return "placeholder source";
    default:
      return "original URL";
  }
}

function formatRedirectMode(mode) {
  switch (mode) {
    case "local-signing":
      return "Extension-built redirect";
    case "service-signing":
      return "Service-built redirect";
    case "direct-redirect-unsafe":
      return "Direct redirect (unsafe)";
    default:
      return "Placeholder source URL";
  }
}

function formatTime(value) {
  if (!value) {
    return "—";
  }

  return new Date(value).toLocaleString();
}

function renderRow(key, value) {
  return `
    <div class="result-row">
      <div class="result-key">${escapeHtml(key)}</div>
      <div class="result-value">${value}</div>
    </div>
  `;
}

function buildFactGrid(items) {
  return items.map((item) => `
    <div class="fact-card">
      <div class="fact-label">${escapeHtml(item.key)}</div>
      <div class="fact-value">${escapeHtml(item.value || "—")}</div>
    </div>
  `).join("");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

function renderVersionFooter() {
  if (!versionFooterNode) {
    return;
  }

  versionFooterNode.textContent = `Version ${EXTENSION_VERSION}`;
}

async function runSave({
  button,
  loadingLabel,
  hint,
  successHint,
  message = { type: "save-active-tab" }
}) {
  setActionButtonsDisabled(true);
  setActionButtonLoading(button, loadingLabel);
  saveHintNode.textContent = hint;

  const response = await chrome.runtime.sendMessage(message);

  if (!response?.ok) {
    resetActionButtons();
    await loadState();
    saveHintNode.textContent = response?.error ?? "Save failed.";
    return;
  }

  resetActionButtons();
  await loadState();
  saveHintNode.textContent = successHint ?? "Saved to Readwise.";
}

function setActionButtonLoading(button, loadingLabel) {
  button.innerHTML = `
    <span class="button-kicker">Working</span>
    <span class="button-title">${escapeHtml(loadingLabel)}</span>
    <span class="button-note">This may take a few seconds.</span>
  `;
}

function resetActionButtons() {
  for (const [button, markup] of actionButtonMarkup.entries()) {
    button.innerHTML = markup;
  }
}
