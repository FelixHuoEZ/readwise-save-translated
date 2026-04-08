const SAVE_ENDPOINT = "https://readwise.io/api/v3/save/";
const FILE_CONFIG_PATH = "config.local.json";
const DEFAULT_TITLE_PREFIX = "[ZH] ";
const DEFAULT_TAGS = ["translated", "snapshot", "lang:zh", "chrome-extension"];
const DEFAULT_CAPTURE_MODE = "html";
const DEFAULT_HTML_SCOPE = "whole-page";
const BADGE_RESET_DELAY_MS = 5000;
const LAST_SAVE_RESULT_KEY = "lastSaveResult";
const DETAILS_MENU_ID = "open-details";

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await chrome.storage.local.get([
    "readwiseToken",
    "titlePrefix",
    "defaultTags",
    "captureMode"
  ]);

  const updates = {};

  if (!settings.titlePrefix) {
    updates.titlePrefix = DEFAULT_TITLE_PREFIX;
  }

  if (!settings.defaultTags) {
    updates.defaultTags = DEFAULT_TAGS;
  }

  if (!settings.captureMode) {
    updates.captureMode = DEFAULT_CAPTURE_MODE;
  }

  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }

  await ensureContextMenus();
});

chrome.runtime.onStartup.addListener(() => {
  void ensureContextMenus();
});

chrome.action.onClicked.addListener((tab) => {
  if (!tab?.id) {
    return;
  }

  void saveActiveTab(tab.id, {
    captureMode: "html",
    forceReaderClean: true,
    htmlScope: "article-only"
  }).catch((error) => handlePrimaryActionError(tab, error));
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === DETAILS_MENU_ID) {
    void openDetailsPage(tab?.id ?? null);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "save-active-tab") {
    void saveActiveTab(message?.tabId, {
      captureMode: message?.captureMode,
      forceReaderClean: message?.forceReaderClean,
      htmlScope: message?.htmlScope
    })
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));

    return true;
  }

  if (message?.type === "get-popup-state") {
    void getPopupState(message?.tabId ?? null)
      .then((state) => sendResponse({ ok: true, state }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));

    return true;
  }
});

async function getPopupState(targetTabId = null) {
  const tab = targetTabId ? await getTabIfExists(targetTabId) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  const settings = await loadResolvedSettings(true);

  return {
    activeTab: tab
      ? {
          id: tab.id,
          title: tab.title ?? "",
          url: tab.url ?? "",
          saveable: Boolean(tab.url && /^https?:/i.test(tab.url))
        }
      : null,
    config: {
      hasToken: Boolean(settings.readwiseToken),
      titlePrefix: settings.titlePrefix,
      defaultTags: settings.defaultTags,
      captureMode: settings.captureMode,
      tokenSource: settings.sources.token,
      titlePrefixSource: settings.sources.titlePrefix,
      tagsSource: settings.sources.defaultTags,
      captureModeSource: settings.sources.captureMode
    },
    lastSaveResult: settings.lastSaveResult
  };
}

async function ensureContextMenus() {
  await chrome.contextMenus.removeAll();
  await chrome.contextMenus.create({
    id: DETAILS_MENU_ID,
    title: "Open details",
    contexts: ["action"]
  });
}

async function openDetailsPage(targetTabId = null) {
  const search = targetTabId ? `?tabId=${encodeURIComponent(String(targetTabId))}` : "";
  await chrome.tabs.create({
    url: chrome.runtime.getURL(`details.html${search}`)
  });
}

async function getTabIfExists(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

async function handlePrimaryActionError(tab, error) {
  if (error?.message?.startsWith("Missing Readwise access token")) {
    await chrome.runtime.openOptionsPage();
    return;
  }

  if (tab?.id) {
    await openDetailsPage(tab.id);
  }
}

async function saveActiveTab(targetTabId = null, overrides = {}) {
  const tab = targetTabId
    ? await chrome.tabs.get(targetTabId)
    : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];

  if (!tab?.id || !tab.url || !/^https?:/i.test(tab.url)) {
    throw new Error("This page cannot be saved. Open a normal http(s) article tab.");
  }

  return performSave(tab, overrides);
}

async function performSave(tab, overrides = {}) {
  try {
    return await withBadge(tab.id, "…", "#5b6cf0", async () => {
      const settings = applySaveOverrides(await loadResolvedSettings(false), overrides);

      if (!settings.readwiseToken) {
        await setBadge(tab.id, "SET", "#d97706");
        throw new Error("Missing Readwise access token. Configure it in the extension options.");
      }

      const [{ result: snapshot }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: capturePageSnapshot
      });

      if (snapshot?.error) {
        throw new Error(`Page capture failed: ${snapshot.error}`);
      }

      if (!snapshot?.html) {
        throw new Error("Unable to capture page HTML.");
      }

      if (settings.htmlScope === "article-only" && !snapshot.articleHtml) {
        throw new Error("No visible article element was found on this page. Use the whole-page fallback instead.");
      }

      const primaryPayload = buildSavePayload(snapshot, settings);
      let saveResult = await saveToReadwise(primaryPayload, settings.readwiseToken);
      let usedFallbackUrl = false;

      if (saveResult.status === 200) {
        const fallbackPayload = buildSavePayload(snapshot, settings, addTranslatedFragment(snapshot.url));
        saveResult = await saveToReadwise(fallbackPayload, settings.readwiseToken);
        usedFallbackUrl = true;
      }

      const resultSummary = {
        savedAt: new Date().toISOString(),
        pageTitle: snapshot.title,
        originalUrl: snapshot.url,
        readerSourceUrl: saveResult.sourceUrl,
        readerDocumentUrl: saveResult.body?.url ?? null,
        readerDocumentId: saveResult.body?.id ?? null,
        captureMode: settings.captureMode,
        detectedCjkCount: snapshot.detectedCjkCount,
        previewText: (snapshot.filteredText || snapshot.visibleText).slice(0, 280),
        contentRootTag: snapshot.contentRootTag,
        contentRootSelector: snapshot.contentRootSelector,
        articleSelector: snapshot.articleSelector,
        contentBlockCount: snapshot.contentBlocks.length,
        readerCleanedHtml: settings.forceReaderClean === true,
        htmlScope: settings.htmlScope,
        usedFallbackUrl,
        status: "success"
      };

      await chrome.storage.local.set({ [LAST_SAVE_RESULT_KEY]: resultSummary });
      await setBadge(tab.id, "OK", "#15803d");
      return resultSummary;
    });
  } catch (error) {
    const failureSummary = {
      savedAt: new Date().toISOString(),
      pageTitle: tab.title ?? "",
      originalUrl: tab.url ?? "",
      readerSourceUrl: null,
      readerDocumentUrl: null,
      readerDocumentId: null,
      captureMode: null,
      detectedCjkCount: null,
      previewText: null,
      contentRootTag: null,
      contentRootSelector: null,
      articleSelector: null,
      contentBlockCount: null,
      readerCleanedHtml: null,
      htmlScope: null,
      usedFallbackUrl: false,
      status: "error",
      error: error.message
    };

    await chrome.storage.local.set({ [LAST_SAVE_RESULT_KEY]: failureSummary });
    console.error(error);

    if (!error.message.startsWith("Missing Readwise access token")) {
      await setBadge(tab.id, "ERR", "#b91c1c");
    }

    throw error;
  }
}

function capturePageSnapshot() {
  const cjkPattern = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;

  try {
    const articleRoot = pickArticleRoot();
    const contentRoot = pickContentRoot();
    const visibleText = normalizeBlockText(contentRoot?.innerText ?? document.body?.innerText ?? "");
    const detectedCjkCount = countCjk(visibleText);
    const translationFirst = detectedCjkCount >= 80;
    let contentBlocks = extractContentBlocks(contentRoot, translationFirst);

    if (contentBlocks.length === 0 && contentRoot !== document.body) {
      contentBlocks = extractContentBlocks(document.body, translationFirst);
    }

    if (contentBlocks.length === 0) {
      contentBlocks = splitFallbackBlocks(visibleText);
    }

    const filteredText = contentBlocks.map((block) => block.text).join("\n\n");

    return {
      title: document.title,
      url: window.location.href,
      html: document.documentElement.outerHTML,
      articleHtml: articleRoot ? buildScopedHtml(articleRoot.outerHTML) : null,
      visibleText,
      filteredText,
      detectedCjkCount,
      contentBlocks,
      contentRootTag: contentRoot?.tagName?.toLowerCase() ?? "body",
      contentRootSelector: describeElement(contentRoot),
      articleSelector: describeElement(articleRoot)
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      html: null,
      articleHtml: null
    };
  }

  function pickArticleRoot() {
    const selectors = ["main article", "[role='main'] article", "article"];

    for (const selector of selectors) {
      const matches = Array.from(document.querySelectorAll(selector))
        .filter(isProbablyVisible)
        .map((element) => ({
          element,
          score: scoreRoot(element)
        }))
        .filter((candidate) => candidate.score > 0)
        .sort((left, right) => right.score - left.score);

      if (matches.length > 0) {
        return matches[0].element;
      }
    }

    return null;
  }

  function pickContentRoot() {
    const selectors = [
      "article",
      "main article",
      "[role='main'] article",
      "[itemprop='articleBody']",
      ".entry-content",
      ".post-content",
      ".article-content",
      ".article-body",
      ".story-content",
      ".story-body",
      "[role='main']",
      "main",
      "body"
    ];

    for (const selector of selectors) {
      const matches = Array.from(document.querySelectorAll(selector))
        .filter(isProbablyVisible)
        .map((element) => ({
          element,
          score: scoreRoot(element)
        }))
        .filter((candidate) => candidate.score > 0)
        .sort((left, right) => right.score - left.score);

      if (matches.length > 0) {
        return matches[0].element;
      }
    }

    return document.body;
  }

  function scoreRoot(element) {
    const text = normalizeBlockText(element.innerText ?? "");
    if (text.length < 200) {
      return 0;
    }

    const blockCount = element.querySelectorAll("h1, h2, h3, h4, h5, h6, p, li, blockquote, figcaption").length;
    const cjkCount = countCjk(text);
    const linkCount = element.querySelectorAll("a").length;

    return Math.min(text.length, 14000) + (blockCount * 80) + (cjkCount * 12) - (Math.min(linkCount, 120) * 8);
  }

  function extractContentBlocks(root, translationFirst) {
    const blockSelector = "h1, h2, h3, h4, h5, h6, p, li, blockquote, figcaption, pre";
    const blocks = [];
    const seenTexts = new Set();
    const elements = root?.matches?.(blockSelector)
      ? [root, ...root.querySelectorAll(blockSelector)]
      : Array.from(root?.querySelectorAll?.(blockSelector) ?? []);

    for (const element of elements) {
      if (!isProbablyVisible(element)) {
        continue;
      }

      if (isNoiseElement(element, root)) {
        continue;
      }

      const rawText = normalizeBlockText(element.innerText ?? element.textContent ?? "");
      if (!rawText) {
        continue;
      }

      if (isStopText(rawText)) {
        break;
      }

      const text = filterBlockText(rawText, translationFirst);
      if (!text) {
        continue;
      }

      const dedupeKey = text.toLowerCase();
      if (seenTexts.has(dedupeKey)) {
        continue;
      }

      seenTexts.add(dedupeKey);
      blocks.push({
        tag: normalizeBlockTag(element.tagName),
        text
      });
    }

    if (translationFirst && blocks.length > 0) {
      const translatedLength = blocks.reduce((total, block) => total + block.text.length, 0);
      if (translatedLength < 300) {
        return extractContentBlocks(root, false);
      }
    }

    return blocks;
  }

  function isNoiseElement(element, root) {
    const blockingSelector = [
      "nav",
      "footer",
      "aside",
      "form",
      "dialog",
      "menu",
      "button",
      "textarea",
      "select",
      "input",
      "[role='navigation']",
      "[role='dialog']",
      "[role='search']",
      "[role='complementary']",
      "[role='menu']",
      "[role='tab']",
      "[role='tablist']",
      "[data-testid*='comment']",
      "[class*='comment']",
      "[id*='comment']",
      "[class*='footer']",
      "[id*='footer']",
      "[class*='subscribe']",
      "[id*='subscribe']",
      "[class*='cookie']",
      "[id*='cookie']",
      "[class*='related']",
      "[id*='related']",
      "[class*='recommend']",
      "[id*='recommend']",
      "[class*='archive']",
      "[id*='archive']",
      "[class*='share']",
      "[id*='share']",
      "[class*='menu']",
      "[id*='menu']",
      "[class*='social']",
      "[id*='social']"
    ].join(", ");
    const blocker = element.closest(blockingSelector);

    return Boolean(blocker && blocker !== root);
  }

  function filterBlockText(text, translationFirst) {
    let lines = text
      .split(/\n+/)
      .map(normalizeLineText)
      .filter(Boolean);

    if (translationFirst) {
      const translatedLines = lines.filter((line) => countCjk(line) > 0);
      if (translatedLines.length > 0) {
        lines = translatedLines;
      }
    }

    lines = lines.filter((line) => !isNoiseLine(line));

    if (lines.length === 0) {
      return "";
    }

    return lines.join("\n");
  }

  function splitFallbackBlocks(text) {
    return text
      .split(/\n{2,}/)
      .map((block) => filterBlockText(block, detectedCjkCount >= 80))
      .filter(Boolean)
      .map((block) => ({ tag: "p", text: block }));
  }

  function isStopText(text) {
    const lower = text.toLowerCase();
    return [
      "discussion about this post",
      "ready for more",
      "cookie policy"
    ].some((pattern) => lower.includes(pattern));
  }

  function isNoiseLine(line) {
    const lower = line.toLowerCase();
    const exactMatches = new Set([
      "subscribe",
      "sign in",
      "share",
      "comments",
      "restacks",
      "top",
      "latest",
      "discussions",
      "manage",
      "reject",
      "accept",
      "reply",
      "previous",
      "next",
      "see all",
      "cookie policy",
      "ready for more?",
      "ready for more",
      "get the app",
      "start your substack"
    ]);

    if (exactMatches.has(lower)) {
      return true;
    }

    if (/^[\d\s.,•∙]+$/.test(line)) {
      return true;
    }

    if (/^like(?:d)?(?:\s*\(\d+\))?$/i.test(line)) {
      return true;
    }

    if (lower.startsWith("liked by ")) {
      return true;
    }

    if (lower.includes("we use cookies")) {
      return true;
    }

    if (lower.includes("privacy") && lower.includes("terms")) {
      return true;
    }

    return false;
  }

  function normalizeLineText(text) {
    return text
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeBlockText(text) {
    return String(text)
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  }

  function normalizeBlockTag(tagName) {
    const tag = String(tagName || "").toLowerCase();
    if (/^h[1-6]$/.test(tag) || tag === "blockquote" || tag === "pre" || tag === "figcaption") {
      return tag;
    }

    return "p";
  }

  function countCjk(text) {
    const matches = String(text).match(cjkPattern);
    return matches ? matches.length : 0;
  }

  function isProbablyVisible(element) {
    if (!(element instanceof Element)) {
      return false;
    }

    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function describeElement(element) {
    if (!(element instanceof Element)) {
      return "";
    }

    const parts = [element.tagName.toLowerCase()];
    if (element.id) {
      parts.push(`#${element.id}`);
    }

    const classList = Array.from(element.classList).slice(0, 2);
    if (classList.length > 0) {
      parts.push(`.${classList.join(".")}`);
    }

    return parts.join("");
  }

  function buildScopedHtml(contentHtml) {
    return [
      "<!doctype html>",
      "<html>",
      "<head>",
      '  <meta charset="utf-8">',
      `  <title>${escapeHtml(document.title)}</title>`,
      `  <base href="${escapeHtml(window.location.href)}">`,
      "</head>",
      "<body>",
      contentHtml,
      "</body>",
      "</html>"
    ].join("\n");
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }
}

async function saveToReadwise(payload, token) {
  const response = await fetch(SAVE_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Token ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Readwise save failed (${response.status}): ${errorText}`);
  }

  const body = await response.json();
  return {
    status: response.status,
    body,
    sourceUrl: payload.url
  };
}

function buildSavePayload(snapshot, settings, sourceUrl = snapshot.url) {
  const titlePrefix = settings.titlePrefix ?? DEFAULT_TITLE_PREFIX;
  const configuredTags = normalizeTags(settings.defaultTags) ?? DEFAULT_TAGS;
  const captureMode = settings.captureMode ?? DEFAULT_CAPTURE_MODE;
  const originalUrl = snapshot.url;
  const author = deriveAuthorName(originalUrl);
  const capturedAt = new Date().toISOString();
  const html = captureMode === "html"
    ? selectHtmlSnapshot(snapshot, settings.htmlScope)
    : buildTextSnapshotHtml(snapshot.title, snapshot.contentBlocks, snapshot.filteredText || snapshot.visibleText);
  const shouldCleanHtml = captureMode === "html" || settings.forceReaderClean === true;

  return {
    url: sourceUrl,
    title: `${titlePrefix}${snapshot.title}`.trim(),
    author,
    html,
    should_clean_html: shouldCleanHtml,
    category: "article",
    saved_using: "readwise-save-translated-extension",
    tags: configuredTags,
    notes: [
      "Saved as a translated snapshot from Chrome.",
      `Capture mode: ${captureMode}`,
      `HTML scope: ${settings.htmlScope}`,
      `Readwise clean HTML: ${shouldCleanHtml ? "enabled" : "disabled"}`,
      `Detected CJK characters: ${snapshot.detectedCjkCount}`,
      `Content root: ${snapshot.contentRootSelector}`,
      `Article root: ${snapshot.articleSelector || "not found"}`,
      `Captured blocks: ${snapshot.contentBlocks.length}`,
      `Original URL: ${originalUrl}`,
      `Reader source URL: ${sourceUrl}`,
      `Captured at: ${capturedAt}`
    ].join("\n")
  };
}

async function loadResolvedSettings(includeLastSaveResult) {
  const storageKeys = ["readwiseToken", "titlePrefix", "defaultTags", "captureMode"];
  if (includeLastSaveResult) {
    storageKeys.push(LAST_SAVE_RESULT_KEY);
  }

  const [storageSettings, fileSettings] = await Promise.all([
    chrome.storage.local.get(storageKeys),
    loadFileSettings()
  ]);

  return {
    readwiseToken: storageSettings.readwiseToken || fileSettings.readwiseToken || "",
    titlePrefix: storageSettings.titlePrefix ?? fileSettings.titlePrefix ?? DEFAULT_TITLE_PREFIX,
    defaultTags: normalizeTags(storageSettings.defaultTags)
      ?? normalizeTags(fileSettings.defaultTags)
      ?? DEFAULT_TAGS,
    captureMode: normalizeCaptureMode(storageSettings.captureMode)
      ?? normalizeCaptureMode(fileSettings.captureMode)
      ?? DEFAULT_CAPTURE_MODE,
    lastSaveResult: includeLastSaveResult ? storageSettings[LAST_SAVE_RESULT_KEY] ?? null : null,
    sources: {
      token: storageSettings.readwiseToken ? "extension" : fileSettings.readwiseToken ? "file" : null,
      titlePrefix: storageSettings.titlePrefix != null ? "extension" : fileSettings.titlePrefix != null ? "file" : "default",
      defaultTags: Array.isArray(storageSettings.defaultTags)
        ? "extension"
        : Array.isArray(fileSettings.defaultTags)
          ? "file"
          : "default",
      captureMode: storageSettings.captureMode != null
        ? "extension"
        : fileSettings.captureMode != null
          ? "file"
          : "default"
    }
  };
}

async function loadFileSettings() {
  try {
    const response = await fetch(chrome.runtime.getURL(FILE_CONFIG_PATH), {
      cache: "no-store"
    });

    if (!response.ok) {
      return {};
    }

    return await response.json();
  } catch {
    return {};
  }
}

function normalizeTags(value) {
  return Array.isArray(value)
    ? value.map((tag) => String(tag).trim()).filter(Boolean)
    : null;
}

function normalizeCaptureMode(value) {
  return value === "html" || value === "text" ? value : null;
}

function normalizeHtmlScope(value) {
  return value === "article-only" || value === "whole-page" ? value : null;
}

function applySaveOverrides(settings, overrides) {
  const captureMode = normalizeCaptureMode(overrides?.captureMode) ?? settings.captureMode;
  return {
    ...settings,
    captureMode,
    forceReaderClean: overrides?.forceReaderClean === true,
    htmlScope: normalizeHtmlScope(overrides?.htmlScope) ?? DEFAULT_HTML_SCOPE
  };
}

function selectHtmlSnapshot(snapshot, htmlScope) {
  if (htmlScope === "article-only") {
    return snapshot.articleHtml;
  }

  return snapshot.html;
}

function buildTextSnapshotHtml(title, contentBlocks, fallbackText) {
  const normalizedTitle = String(title || "").trim().toLowerCase();
  const blocks = Array.isArray(contentBlocks) && contentBlocks.length > 0
    ? contentBlocks.filter((block, index) => {
        if (!block?.text) {
          return false;
        }

        return !(
          index === 0
          && block.tag === "h1"
          && String(block.text).trim().toLowerCase() === normalizedTitle
        );
      })
    : splitTextFallback(fallbackText);

  const content = blocks.length > 0
    ? blocks.map(renderTextBlock).join("\n")
    : "<p>No visible text was captured from the page.</p>";

  return [
    "<!doctype html>",
    "<html>",
    "<head>",
    '  <meta charset="utf-8">',
    `  <title>${escapeHtml(title)}</title>`,
    "</head>",
    '<body style="font-family: Georgia, serif; max-width: 46rem; margin: 2rem auto; line-height: 1.75; padding: 0 1rem;">',
    `  <h1>${escapeHtml(title)}</h1>`,
    `  ${content}`,
    "</body>",
    "</html>"
  ].join("\n");
}

function renderTextBlock(block) {
  const tag = /^(h[1-6]|blockquote|pre|figcaption)$/.test(block.tag) ? block.tag : "p";
  const text = escapeHtml(block.text).replaceAll("\n", "<br>");
  return `<${tag}>${text}</${tag}>`;
}

function splitTextFallback(text) {
  return String(text || "")
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => ({ tag: "p", text: block }));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function addTranslatedFragment(url) {
  const timestamp = Date.now();
  const fragment = `rw-translated=${timestamp}`;

  if (url.includes("#")) {
    return `${url}&${fragment}`;
  }

  return `${url}#${fragment}`;
}

function deriveAuthorName(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "translated-page";
  }
}

async function withBadge(tabId, text, color, work) {
  await setBadge(tabId, text, color);

  try {
    return await work();
  } finally {
    if (tabId) {
      setTimeout(() => {
        chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
      }, BADGE_RESET_DELAY_MS);
    }
  }
}

async function setBadge(tabId, text, color) {
  if (!tabId) {
    return;
  }

  await chrome.action.setBadgeBackgroundColor({ tabId, color });
  await chrome.action.setBadgeText({ tabId, text });
}
