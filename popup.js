const pageTitleNode = document.querySelector("#page-title");
const pageUrlNode = document.querySelector("#page-url");
const tokenPill = document.querySelector("#token-pill");
const pagePill = document.querySelector("#page-pill");
const modePill = document.querySelector("#mode-pill");
const articleSaveButton = document.querySelector("#article-save-button");
const wholePageButton = document.querySelector("#whole-page-button");
const settingsButton = document.querySelector("#settings-button");
const copyDebugButton = document.querySelector("#copy-debug-button");
const saveHintNode = document.querySelector("#save-hint");
const lastSaveNode = document.querySelector("#last-save");
const targetTabId = parseTargetTabId();
let currentLastSaveResult = null;

settingsButton.addEventListener("click", async () => {
  await chrome.runtime.openOptionsPage();
});

copyDebugButton.addEventListener("click", async () => {
  const debugText = buildDebugText(currentLastSaveResult);
  if (!debugText) {
    saveHintNode.textContent = "No debug info is available yet.";
    return;
  }

  try {
    await navigator.clipboard.writeText(debugText);
    copyDebugButton.textContent = "Copied";
    window.setTimeout(() => {
      copyDebugButton.textContent = "Copy debug info";
    }, 1500);
  } catch {
    saveHintNode.textContent = "Copy failed. Select the text manually from the details page.";
  }
});

articleSaveButton.addEventListener("click", async () => {
  await runSave({
    button: articleSaveButton,
    loadingLabel: "Saving…",
    idleLabel: "Use fallback source URL",
    successHint: "Saved to Readwise with the fallback source URL.",
    hint: "Saving with the fallback source URL so Readwise keeps the translated HTML, then adding an original-article link into the saved document.",
    message: {
      type: "save-active-tab",
      tabId: targetTabId,
      captureMode: "html",
      forceReaderClean: true,
      htmlScope: "article-only",
      useSyntheticUrl: true
    }
  });
});

wholePageButton.addEventListener("click", async () => {
  await runSave({
    button: wholePageButton,
    loadingLabel: "Saving…",
    idleLabel: "Retry default save",
    successHint: "Saved to Readwise with the default source URL path.",
    hint: "Saving with the original page URL, which keeps Reader's native source link behavior.",
    message: {
      type: "save-active-tab",
      tabId: targetTabId,
      captureMode: "html",
      forceReaderClean: true,
      htmlScope: "whole-page",
      useSyntheticUrl: false
    }
  });
});

void loadState();

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
  setPill(
    modePill,
    "Original URL default",
    "ok"
  );

  setActionButtonsDisabled(!config.hasToken || !activeTab?.saveable);

  if (!config.hasToken) {
    saveHintNode.textContent = "Add your Readwise token before testing the extension.";
    return;
  }

  if (!activeTab?.saveable) {
    saveHintNode.textContent = "Open this details page from the extension icon on a normal http(s) article tab.";
    return;
  }

  if (config.redirectBaseUrl && config.hasRedirectSigningSecret) {
    saveHintNode.textContent = `Left click uses the original page URL. If Reader collapses the saved content back to English, fallback saves will use ${config.redirectBaseUrl}.`;
    return;
  }

  saveHintNode.textContent = "Left click uses the original page URL. If Reader collapses the saved content back to English, use the fallback source URL here or from the action right-click menu.";
}

function renderLastSave(lastSaveResult) {
  copyDebugButton.disabled = !lastSaveResult;

  if (!lastSaveResult) {
    lastSaveNode.innerHTML = '<p class="empty">No save has been attempted from this extension yet.</p>';
    return;
  }

  const rows = [];
  rows.push(renderRow("Saved at", formatTime(lastSaveResult.savedAt)));
  rows.push(renderRow("Original URL", escapeHtml(lastSaveResult.originalUrl || "—")));

  if (lastSaveResult.readerSourceUrl) {
    rows.push(renderRow("Reader source URL", escapeHtml(lastSaveResult.readerSourceUrl)));
  }

  if (lastSaveResult.usedRedirectUrl) {
    rows.push(renderRow("Source strategy", "Redirect fallback"));
  } else if (lastSaveResult.usedSyntheticUrl) {
    rows.push(renderRow("Source strategy", "Synthetic URL fallback"));
  } else {
    rows.push(renderRow("Source strategy", "Original URL"));
  }

  if (lastSaveResult.existingDocumentDetected) {
    rows.push(renderRow("Existing Reader doc", "This URL already existed in Reader."));
  }

  if (lastSaveResult.existingDocumentUrl) {
    rows.push(
      renderRow(
        "Existing Reader link",
        `<a href="${escapeAttribute(lastSaveResult.existingDocumentUrl)}" target="_blank" rel="noreferrer">${escapeHtml(lastSaveResult.existingDocumentUrl)}</a>`
      )
    );
  }

  if (lastSaveResult.pageTitle) {
    rows.push(renderRow("Resolved title", escapeHtml(lastSaveResult.pageTitle)));
  }

  if (lastSaveResult.parserTitle) {
    rows.push(renderRow("Parser title", escapeHtml(lastSaveResult.parserTitle)));
  }

  if (lastSaveResult.ingestTitle) {
    rows.push(renderRow("Ingest title", escapeHtml(lastSaveResult.ingestTitle)));
  }

  if (lastSaveResult.displayTitle) {
    rows.push(renderRow("Display title", escapeHtml(lastSaveResult.displayTitle)));
  }

  if (lastSaveResult.originalTitle) {
    rows.push(renderRow("Original title", escapeHtml(lastSaveResult.originalTitle)));
  }

  if (lastSaveResult.translatedTitle) {
    rows.push(renderRow("Translated title", escapeHtml(lastSaveResult.translatedTitle)));
  }

  if (lastSaveResult.author) {
    rows.push(renderRow("Author", escapeHtml(lastSaveResult.author)));
  }

  if (lastSaveResult.publishedDate) {
    rows.push(renderRow("Published", escapeHtml(formatTime(lastSaveResult.publishedDate))));
  }

  if (lastSaveResult.captureMode) {
    rows.push(renderRow("Capture mode", escapeHtml(lastSaveResult.captureMode)));
  }

  if (lastSaveResult.htmlScope) {
    rows.push(renderRow("HTML scope", escapeHtml(lastSaveResult.htmlScope)));
  }

  if (typeof lastSaveResult.readerCleanedHtml === "boolean") {
    rows.push(renderRow("Reader clean HTML", lastSaveResult.readerCleanedHtml ? "Enabled" : "Disabled"));
  }

  if (lastSaveResult.titleUpdateApplied) {
    rows.push(renderRow("Title update", "Applied after save"));
  } else if (lastSaveResult.titleUpdateError) {
    rows.push(renderRow("Title update", escapeHtml(lastSaveResult.titleUpdateError)));
  }

  if (lastSaveResult.contentRootSelector) {
    rows.push(renderRow("Content root", escapeHtml(lastSaveResult.contentRootSelector)));
  }

  if (lastSaveResult.articleSelector) {
    rows.push(renderRow("Article root", escapeHtml(lastSaveResult.articleSelector)));
  }

  if (typeof lastSaveResult.detectedCjkCount === "number") {
    rows.push(renderRow("Detected CJK", String(lastSaveResult.detectedCjkCount)));
  }

  if (typeof lastSaveResult.contentBlockCount === "number") {
    rows.push(renderRow("Blocks kept", String(lastSaveResult.contentBlockCount)));
  }

  if (lastSaveResult.previewText) {
    rows.push(renderRow("Preview", escapeHtml(lastSaveResult.previewText)));
  }

  if (lastSaveResult.usedFallbackUrl) {
    rows.push(renderRow("URL fallback", "Fragment-based retry was used."));
  }

  if (lastSaveResult.error) {
    rows.push(renderRow("Error", escapeHtml(lastSaveResult.error)));
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
  const syntheticBadge = lastSaveResult.usedSyntheticUrl && !lastSaveResult.usedRedirectUrl
    ? '<span class="scope-badge">synthetic fallback</span>'
    : "";
  const redirectBadge = lastSaveResult.usedRedirectUrl
    ? '<span class="scope-badge">redirect fallback</span>'
    : "";
  const existingBadge = lastSaveResult.existingDocumentDetected
    ? '<span class="scope-badge">existing doc</span>'
    : "";
  const debugText = buildDebugText(lastSaveResult);
  const detailsOpen = lastSaveResult.status === "error" ? " open" : "";

  lastSaveNode.innerHTML = `
    <div class="result-summary">
      <div class="status-line">
        <span class="status-badge ${statusClass}">${escapeHtml(formatStatus(lastSaveResult))}</span>
        ${scopeBadge}
        ${redirectBadge}
        ${syntheticBadge}
        ${fallbackBadge}
        ${existingBadge}
      </div>
      ${readerLink}
      <div class="result-meta">Saved ${escapeHtml(formatTime(lastSaveResult.savedAt))}</div>
      <details${detailsOpen}>
        <summary>Diagnostics</summary>
        <div class="result-grid">${rows.join("")}</div>
        <pre class="debug-block">${escapeHtml(debugText)}</pre>
      </details>
    </div>
  `;
}

function renderFailureState(message) {
  pageTitleNode.textContent = "Popup state unavailable";
  pageUrlNode.textContent = message;
  setPill(tokenPill, "State error", "error");
  setPill(pagePill, "State error", "error");
  setPill(modePill, "State error", "error");
  setActionButtonsDisabled(true);
  saveHintNode.textContent = message;
  lastSaveNode.innerHTML = '<p class="empty">Refresh the details page and try again.</p>';
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
    `status: ${lastSaveResult.status || ""}`,
    `savedAt: ${lastSaveResult.savedAt || ""}`,
    `originalUrl: ${lastSaveResult.originalUrl || ""}`,
    `readerDocumentUrl: ${lastSaveResult.readerDocumentUrl || ""}`,
    `readerSourceUrl: ${lastSaveResult.readerSourceUrl || ""}`,
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
    if (result.usedRedirectUrl) {
      return "Saved with redirect fallback";
    }

    if (result.usedSyntheticUrl) {
      return "Saved with synthetic fallback";
    }

    if (result.existingDocumentDetected) {
      return "Saved with existing Reader doc";
    }

    return result.usedFallbackUrl ? "Saved with fallback URL" : "Saved successfully";
  }

  return "Save failed";
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

async function runSave({
  button,
  loadingLabel,
  idleLabel,
  hint,
  successHint,
  message = { type: "save-active-tab" }
}) {
  const articleIdleLabel = articleSaveButton.textContent;
  const wholePageIdleLabel = wholePageButton.textContent;
  setActionButtonsDisabled(true);
  button.textContent = loadingLabel;
  saveHintNode.textContent = hint;

  const response = await chrome.runtime.sendMessage(message);

  if (!response?.ok) {
    articleSaveButton.textContent = articleIdleLabel;
    wholePageButton.textContent = wholePageIdleLabel;
    await loadState();
    saveHintNode.textContent = response?.error ?? "Save failed.";
    return;
  }

  articleSaveButton.textContent = articleIdleLabel;
  wholePageButton.textContent = wholePageIdleLabel;
  await loadState();
  button.textContent = idleLabel;
  saveHintNode.textContent = successHint ?? "Saved to Readwise.";
}
