import {
  REDIRECT_VERSION,
  buildSignedRedirectUrl,
  buildUnsignedRedirectUrl,
  normalizeRedirectBaseUrl
} from "./lib/redirect-url.js";

const SAVE_ENDPOINT = "https://readwise.io/api/v3/save/";
const FILE_CONFIG_PATH = "config.local.json";
const LEGACY_TITLE_PREFIX = "[ZH] ";
const DEFAULT_TITLE_PREFIX = "";
const LEGACY_DEFAULT_TAGS = ["translated", "snapshot", "lang:zh", "chrome-extension"];
const DEFAULT_TAGS = [];
const DEFAULT_CAPTURE_MODE = "html";
const DEFAULT_HTML_SCOPE = "whole-page";
const DEFAULT_REDIRECT_MODE = "synthetic";
const DEFAULT_REDIRECT_BASE_URL = "";
const DEFAULT_REDIRECT_SERVICE_URL = "";
const LAST_SAVE_RESULT_KEY = "lastSaveResult";
const TAB_ACTION_STATES_KEY = "tabActionStates";
const SETTINGS_MENU_ID = "open-settings";
const DETAILS_MENU_ID = "open-details";
const DEFAULT_SAVE_MENU_ID = "save-original-default";
const FALLBACK_MODE_MENU_ID = "save-fallback-mode";
const DEFAULT_ACTION_TITLE = "Left click: save with original URL. Right click: settings, default save, fallback mode, or open details.";
const DEFAULT_ACTION_ICON_PATHS = {
  16: "assets/icon-16.png",
  32: "assets/icon-32.png"
};
const SUCCESS_ACTION_ICON_PATHS = {
  16: "assets/icon-success-16.png",
  32: "assets/icon-success-32.png"
};
const ERROR_ACTION_ICON_PATHS = {
  16: "assets/icon-error-16.png",
  32: "assets/icon-error-32.png"
};
const EXTENSION_VERSION = chrome.runtime.getManifest().version;
const REDIRECT_MODE_SYNTHETIC = "synthetic";
const REDIRECT_MODE_LOCAL_SIGNING = "local-signing";
const REDIRECT_MODE_SERVICE_SIGNING = "service-signing";
const REDIRECT_MODE_DIRECT_UNSAFE = "direct-redirect-unsafe";

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await chrome.storage.local.get([
    "readwiseToken",
    "titlePrefix",
    "defaultTags",
    "captureMode",
    "redirectMode",
    "redirectModeExplicit",
    "redirectConfigs",
    "redirectBaseUrl",
    "redirectServiceUrl",
    "redirectSigningSecret"
  ]);

  const updates = {};

  if (settings.titlePrefix == null) {
    updates.titlePrefix = DEFAULT_TITLE_PREFIX;
  }

  if (!settings.defaultTags) {
    updates.defaultTags = DEFAULT_TAGS;
  }

  if (areSameTags(normalizeTags(settings.defaultTags), LEGACY_DEFAULT_TAGS)) {
    updates.defaultTags = DEFAULT_TAGS;
  }

  if (!settings.captureMode) {
    updates.captureMode = DEFAULT_CAPTURE_MODE;
  }

  if (!normalizeRedirectMode(settings.redirectMode)) {
    updates.redirectMode = inferRedirectMode({
      redirectBaseUrl: settings.redirectBaseUrl,
      redirectServiceUrl: settings.redirectServiceUrl,
      redirectSigningSecret: settings.redirectSigningSecret
    });
  }

  if (!normalizeRedirectConfigsValue(settings.redirectConfigs)) {
    const legacyConfigs = deriveLegacyRedirectConfigs(settings);
    if (legacyConfigs) {
      updates.redirectConfigs = legacyConfigs;
    }
  }

  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }

  await migrateLegacyTitlePrefix();
  await ensureContextMenus();
  await setVisibleActionIcon("default");
  await setVisibleActionTitle(DEFAULT_ACTION_TITLE);
});

chrome.runtime.onStartup.addListener(() => {
  void ensureContextMenus();
  void migrateLegacyDefaultTags();
  void migrateLegacyTitlePrefix();
  void migrateRedirectSettings();
  void setVisibleActionIcon("default");
  void setVisibleActionTitle(DEFAULT_ACTION_TITLE);
  void syncFocusedWindowActionState();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" || typeof changeInfo.url === "string") {
    void resetTabActionState(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void resetTabActionState(tabId);
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void syncActionStateForTab(tabId);
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    return;
  }

  void syncFocusedWindowActionState(windowId);
});

chrome.action.onClicked.addListener((tab) => {
  if (!tab?.id) {
    return;
  }

  void saveActiveTab(tab.id, {
    captureMode: "html",
    forceReaderClean: true,
    htmlScope: "whole-page"
  }).catch((error) => handlePrimaryActionError(tab, error));
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === SETTINGS_MENU_ID) {
    void chrome.runtime.openOptionsPage();
    return;
  }

  if (info.menuItemId === DETAILS_MENU_ID) {
    void openDetailsPage(tab?.id ?? null);
    return;
  }

  if (info.menuItemId === DEFAULT_SAVE_MENU_ID && tab?.id) {
    void saveActiveTab(tab.id, {
      captureMode: "html",
      forceReaderClean: true,
      htmlScope: "whole-page",
      useFallbackSource: false
    }).catch((error) => handlePrimaryActionError(tab, error));
    return;
  }

  if (info.menuItemId === FALLBACK_MODE_MENU_ID && tab?.id) {
    void saveActiveTab(tab.id, {
      captureMode: "html",
      forceReaderClean: true,
      htmlScope: "article-only",
      useFallbackSource: true
    }).catch((error) => handlePrimaryActionError(tab, error));
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "save-active-tab") {
    void saveActiveTab(message?.tabId, {
      captureMode: message?.captureMode,
      forceReaderClean: message?.forceReaderClean,
      htmlScope: message?.htmlScope,
      useFallbackSource: message?.useFallbackSource ?? message?.useSyntheticUrl
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
      redirectMode: settings.redirectMode,
      redirectBaseUrl: settings.redirectBaseUrl,
      redirectServiceUrl: settings.redirectServiceUrl,
      hasRedirectSigningSecret: Boolean(settings.redirectSigningSecret),
      tokenSource: settings.sources.token,
      titlePrefixSource: settings.sources.titlePrefix,
      tagsSource: settings.sources.defaultTags,
      captureModeSource: settings.sources.captureMode,
      redirectModeSource: settings.sources.redirectMode,
      redirectBaseUrlSource: settings.sources.redirectBaseUrl,
      redirectServiceUrlSource: settings.sources.redirectServiceUrl,
      redirectSigningSecretSource: settings.sources.redirectSigningSecret
    },
    lastSaveResult: settings.lastSaveResult
  };
}

async function ensureContextMenus() {
  await chrome.contextMenus.removeAll();
  await chrome.contextMenus.create({
    id: SETTINGS_MENU_ID,
    title: "Settings",
    contexts: ["action"]
  });
  await chrome.contextMenus.create({
    id: DEFAULT_SAVE_MENU_ID,
    title: "Save with original URL (default)",
    contexts: ["action"]
  });
  await chrome.contextMenus.create({
    id: FALLBACK_MODE_MENU_ID,
    title: "Save with fallback mode",
    contexts: ["action"]
  });
  await chrome.contextMenus.create({
    id: DETAILS_MENU_ID,
    title: "Open details",
    contexts: ["action"]
  });
}

async function migrateLegacyDefaultTags() {
  const { defaultTags } = await chrome.storage.local.get(["defaultTags"]);
  if (areSameTags(normalizeTags(defaultTags), LEGACY_DEFAULT_TAGS)) {
    await chrome.storage.local.set({ defaultTags: DEFAULT_TAGS });
  }
}

async function migrateLegacyTitlePrefix() {
  const { titlePrefix } = await chrome.storage.local.get(["titlePrefix"]);
  if (titlePrefix === LEGACY_TITLE_PREFIX) {
    await chrome.storage.local.set({ titlePrefix: DEFAULT_TITLE_PREFIX });
  }
}

async function migrateRedirectSettings() {
  const settings = await chrome.storage.local.get([
    "redirectMode",
    "redirectModeExplicit",
    "redirectConfigs",
    "redirectBaseUrl",
    "redirectServiceUrl",
    "redirectSigningSecret"
  ]);

  const updates = {};

  if (!normalizeRedirectMode(settings.redirectMode)) {
    updates.redirectMode = inferRedirectMode(settings);
  }

  if (!normalizeRedirectConfigsValue(settings.redirectConfigs)) {
    const legacyConfigs = deriveLegacyRedirectConfigs(settings);
    if (legacyConfigs) {
      updates.redirectConfigs = legacyConfigs;
    }
  }

  if (settings.redirectServiceUrl == null) {
    updates.redirectServiceUrl = DEFAULT_REDIRECT_SERVICE_URL;
  }

  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }
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
  let resolvedSettings = null;

  try {
    return await withBadge(tab.id, "…", "#5b6cf0", async () => {
      const settings = applySaveOverrides(await loadResolvedSettings(false), overrides);
      resolvedSettings = settings;

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

      const useFallbackSource = overrides?.useFallbackSource === true;
      let sourceStrategy = "original-url";
      const primarySource = useFallbackSource
        ? await buildFallbackSourceUrl(snapshot.url, settings)
        : { sourceUrl: snapshot.url, strategy: "original-url" };
      const primarySourceUrl = primarySource.sourceUrl;
      sourceStrategy = primarySource.strategy;
      const primarySaveRequest = buildSavePayload(snapshot, settings, primarySourceUrl, { useFallbackSource });
      let saveResult = await saveToReadwise(primarySaveRequest.payload, settings.readwiseToken);
      let usedFallbackUrl = false;
      let existingDocumentDetected = false;
      let existingDocumentUrl = null;
      let existingDocumentId = null;
      let saveRequest = primarySaveRequest;

      if (saveResult.status === 200) {
        if (!useFallbackSource) {
          existingDocumentDetected = true;
          existingDocumentUrl = saveResult.body?.url ?? null;
          existingDocumentId = saveResult.body?.id ?? null;
        }

        const retrySource = useFallbackSource
          ? await buildFallbackSourceUrl(snapshot.url, settings)
          : { sourceUrl: addTranslatedFragment(snapshot.url), strategy: "original-url" };
        const fallbackSaveRequest = buildSavePayload(snapshot, settings, retrySource.sourceUrl, { useFallbackSource });
        saveRequest = fallbackSaveRequest;
        saveResult = await saveToReadwise(fallbackSaveRequest.payload, settings.readwiseToken);
        usedFallbackUrl = true;
        sourceStrategy = retrySource.strategy;
      }

      const savedDocumentId = saveResult.body?.id ?? null;
      let titleUpdateApplied = false;
      let titleUpdateError = null;

      if (
        savedDocumentId
        && saveRequest.displayTitle
        && saveRequest.displayTitle !== saveRequest.ingestTitle
      ) {
        try {
          await updateReadwiseDocument(savedDocumentId, { title: saveRequest.displayTitle }, settings.readwiseToken);
          titleUpdateApplied = true;
        } catch (error) {
          titleUpdateError = error instanceof Error ? error.message : String(error);
        }
      }

      const resultSummary = {
        savedAt: new Date().toISOString(),
        pageTitle: snapshot.title,
        parserTitle: snapshot.parserTitle,
        originalTitle: snapshot.originalTitle,
        translatedTitle: snapshot.translatedTitle,
        originalUrl: snapshot.url,
        readerSourceUrl: saveResult.sourceUrl,
        readerDocumentUrl: saveResult.body?.url ?? null,
        readerDocumentId: saveResult.body?.id ?? null,
        existingDocumentDetected,
        existingDocumentUrl,
        existingDocumentId,
        author: snapshot.metadata.author,
        publishedDate: snapshot.metadata.publishedDate,
        captureMode: settings.captureMode,
        detectedCjkCount: snapshot.detectedCjkCount,
        previewText: (snapshot.filteredText || snapshot.visibleText).slice(0, 280),
        contentRootTag: snapshot.contentRootTag,
        contentRootSelector: snapshot.contentRootSelector,
        articleSelector: snapshot.articleSelector,
        contentBlockCount: snapshot.contentBlocks.length,
        readerCleanedHtml: settings.forceReaderClean === true,
        htmlScope: settings.htmlScope,
        redirectMode: settings.redirectMode,
        sourceStrategy,
        ingestTitle: saveRequest.ingestTitle,
        displayTitle: saveRequest.displayTitle,
        titleUpdateApplied,
        titleUpdateError,
        usedSyntheticUrl: sourceStrategy === REDIRECT_MODE_SYNTHETIC,
        usedRedirectUrl: isRedirectSourceStrategy(sourceStrategy),
        usedFallbackUrl,
        status: "success"
      };

      await chrome.storage.local.set({ [LAST_SAVE_RESULT_KEY]: resultSummary });
      await storeTabActionState(tab.id, {
        state: "success",
        title: buildSuccessActionTitle(resultSummary)
      });
      await clearBadge(tab.id);
      if (tab.active) {
        await setVisibleActionIcon("success");
        await setVisibleActionTitle(buildSuccessActionTitle(resultSummary));
      }
      return resultSummary;
    });
  } catch (error) {
    const failureSummary = {
      savedAt: new Date().toISOString(),
      pageTitle: tab.title ?? "",
      parserTitle: null,
      ingestTitle: null,
      displayTitle: null,
      originalUrl: tab.url ?? "",
      readerSourceUrl: null,
      readerDocumentUrl: null,
      readerDocumentId: null,
      existingDocumentDetected: false,
      existingDocumentUrl: null,
      existingDocumentId: null,
      redirectMode: resolvedSettings?.redirectMode ?? null,
      sourceStrategy: null,
      originalTitle: null,
      translatedTitle: null,
      usedRedirectUrl: false,
      author: null,
      publishedDate: null,
      captureMode: null,
      detectedCjkCount: null,
      previewText: null,
      contentRootTag: null,
      contentRootSelector: null,
      articleSelector: null,
      contentBlockCount: null,
      readerCleanedHtml: null,
      htmlScope: null,
      titleUpdateApplied: false,
      titleUpdateError: null,
      usedSyntheticUrl: false,
      usedFallbackUrl: false,
      status: "error",
      error: error.message
    };

    await chrome.storage.local.set({ [LAST_SAVE_RESULT_KEY]: failureSummary });
    console.error(error);

    if (!error.message.startsWith("Missing Readwise access token")) {
      await storeTabActionState(tab.id, {
        state: "error",
        title: buildErrorActionTitle(error.message)
      });
      await clearBadge(tab.id);
      if (tab.active) {
        await setVisibleActionIcon("error");
        await setVisibleActionTitle(buildErrorActionTitle(error.message));
      }
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
    const metadata = extractMetadata();
    const titleInfo = extractTitleInfo(articleRoot, contentRoot);

    return {
      title: titleInfo.resolvedTitle,
      originalTitle: titleInfo.originalTitle,
      translatedTitle: titleInfo.translatedTitle,
      parserTitle: titleInfo.parserTitle,
      url: window.location.href,
      html: document.documentElement.outerHTML,
      articleHtml: articleRoot ? buildScopedDocumentHtml(articleRoot, titleInfo.parserTitle) : null,
      visibleText,
      filteredText,
      detectedCjkCount,
      contentBlocks,
      metadata,
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

  function buildScopedDocumentHtml(contentRoot, pageTitle = document.title) {
    if (!(contentRoot instanceof Element)) {
      return "";
    }

    const scopedDocument = document.implementation.createHTMLDocument(pageTitle);

    copyAttributes(document.documentElement, scopedDocument.documentElement);
    copyAttributes(document.body, scopedDocument.body);

    scopedDocument.head.innerHTML = "";
    for (const node of Array.from(document.head.childNodes)) {
      scopedDocument.head.appendChild(node.cloneNode(true));
    }

    scopedDocument.body.innerHTML = "";
    scopedDocument.body.appendChild(contentRoot.cloneNode(true));

    ensureBaseHref(scopedDocument);
    ensureMetaCharset(scopedDocument);

    return `<!doctype html>\n${scopedDocument.documentElement.outerHTML}`;
  }

  function copyAttributes(source, target) {
    if (!(source instanceof Element) || !(target instanceof Element)) {
      return;
    }

    for (const attribute of Array.from(target.attributes)) {
      target.removeAttribute(attribute.name);
    }

    for (const attribute of Array.from(source.attributes)) {
      target.setAttribute(attribute.name, attribute.value);
    }
  }

  function ensureBaseHref(scopedDocument) {
    let baseElement = scopedDocument.head.querySelector("base");
    if (!(baseElement instanceof HTMLBaseElement)) {
      baseElement = scopedDocument.createElement("base");
      scopedDocument.head.prepend(baseElement);
    }

    baseElement.setAttribute("href", window.location.href);
  }

  function ensureMetaCharset(scopedDocument) {
    if (scopedDocument.head.querySelector('meta[charset]')) {
      return;
    }

    const metaCharset = scopedDocument.createElement("meta");
    metaCharset.setAttribute("charset", "utf-8");
    scopedDocument.head.prepend(metaCharset);
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function extractTitleInfo(articleRoot, contentRoot) {
    const heading = pickPrimaryHeading(articleRoot, contentRoot);
    const originalTitle = resolveOriginalTitle(heading);
    const translatedTitle = findTranslatedTitleNearHeading(heading, articleRoot ?? contentRoot ?? document.body);
    const resolvedTitle = buildResolvedTitle(originalTitle, translatedTitle, document.title);
    const parserTitle = normalizeHeadingText(translatedTitle) || normalizeHeadingText(originalTitle) || document.title;

    return {
      originalTitle,
      translatedTitle,
      resolvedTitle,
      parserTitle
    };
  }

  function buildResolvedTitle(originalTitle, translatedTitle, fallbackTitle) {
    const normalizedOriginal = normalizeHeadingText(originalTitle);
    const normalizedTranslated = normalizeHeadingText(translatedTitle);

    if (normalizedOriginal && normalizedTranslated) {
      const lowerOriginal = normalizedOriginal.toLowerCase();
      const lowerTranslated = normalizedTranslated.toLowerCase();
      if (lowerOriginal === lowerTranslated) {
        return normalizedOriginal;
      }

      if (lowerOriginal.includes(lowerTranslated)) {
        return normalizedOriginal;
      }

      if (lowerTranslated.includes(lowerOriginal)) {
        return normalizedTranslated;
      }

      return `${normalizedOriginal} ${normalizedTranslated}`;
    }

    return normalizedTranslated || normalizedOriginal || fallbackTitle;
  }

  function pickPrimaryHeading(articleRoot, contentRoot) {
    const roots = [articleRoot, contentRoot, document.body].filter(Boolean);

    for (const root of roots) {
      const headings = Array.from(root.querySelectorAll("h1")).filter(isProbablyVisible);
      if (headings.length > 0) {
        return headings
          .map((element) => ({
            element,
            score: countCjk(normalizeBlockText(element.innerText ?? "")) * 20
              + normalizeBlockText(element.innerText ?? "").length
          }))
          .sort((left, right) => right.score - left.score)[0].element;
      }
    }

    return document.querySelector("h1");
  }

  function resolveOriginalTitle(heading) {
    const headingText = normalizeHeadingText(heading?.innerText ?? "");
    if (headingText) {
      return headingText;
    }

    const metaTitle = normalizeHeadingText(
      getMetaContent([
        'meta[property="og:title"]',
        'meta[name="twitter:title"]'
      ])
    );

    return metaTitle || normalizeHeadingText(document.title);
  }

  function findTranslatedTitleNearHeading(heading, root) {
    if (!(heading instanceof Element)) {
      return "";
    }

    const headingRect = heading.getBoundingClientRect();
    const inlineCandidate = pickTranslatedLine(collectCandidateLines(heading), headingRect.bottom, 0);
    if (inlineCandidate) {
      return inlineCandidate;
    }

    let sibling = heading.nextElementSibling;
    let siblingChecks = 0;
    while (sibling && siblingChecks < 6) {
      siblingChecks += 1;
      if (isProbablyVisible(sibling)) {
        const siblingRect = sibling.getBoundingClientRect();
        const distance = siblingRect.top - headingRect.bottom;
        if (distance <= 220) {
          const candidate = pickTranslatedLine(
            collectCandidateLines(sibling),
            siblingRect.top,
            Math.abs((siblingRect.left || 0) - (headingRect.left || 0))
          );
          if (candidate) {
            return candidate;
          }
        }
      }

      sibling = sibling.nextElementSibling;
    }

    const rootCandidates = Array.from(root?.querySelectorAll?.("p, div, h2, span") ?? [])
      .filter(isProbablyVisible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          lines: collectCandidateLines(element),
          distance: rect.top - headingRect.bottom,
          horizontalOffset: Math.abs((rect.left || 0) - (headingRect.left || 0))
        };
      })
      .filter((candidate) => candidate.distance >= -8 && candidate.distance <= 220)
      .sort((left, right) => left.distance - right.distance);

    for (const candidate of rootCandidates) {
      const resolved = pickTranslatedLine(candidate.lines, candidate.distance, candidate.horizontalOffset);
      if (resolved) {
        return resolved;
      }
    }

    return "";
  }

  function collectCandidateLines(element) {
    return normalizeBlockText(element?.innerText ?? "")
      .split(/\n+/)
      .map(normalizeHeadingText)
      .filter(Boolean);
  }

  function pickTranslatedLine(lines, verticalDistance, horizontalOffset) {
    const scored = lines
      .filter((line) => countCjk(line) > 0)
      .filter((line) => line.length >= 4 && line.length <= 80)
      .filter((line) => !isNoiseLine(line))
      .map((line) => ({
        line,
        score: (countCjk(line) * 14)
          - Math.abs(line.length - 18)
          - Math.max(0, verticalDistance) * 0.2
          - horizontalOffset * 0.05
      }))
      .sort((left, right) => right.score - left.score);

    return scored[0]?.line ?? "";
  }

  function normalizeHeadingText(text) {
    return normalizeLineText(String(text || "").replace(/\s*[|·•-]\s*[^|·•-]+$/, ""));
  }

  function extractMetadata() {
    const structuredData = parseStructuredData();
    const author = normalizeAuthorName(
      getMetaContent([
        'meta[name="author"]',
        'meta[property="author"]',
        'meta[property="article:author"]',
        'meta[name="parsely-author"]'
      ])
        || extractAuthorFromStructuredData(structuredData)
        || extractVisibleText([
          '[itemprop="author"]',
          '[rel="author"]',
          '.byline-wrapper a',
          '[class*="byline"] a',
          '[class*="author"] a',
          '[data-testid*="author"] a'
        ])
    );
    const publishedDate = normalizePublishedDate(
      getMetaContent([
        'meta[property="article:published_time"]',
        'meta[name="article:published_time"]',
        'meta[name="pubdate"]',
        'meta[name="publish-date"]',
        'meta[name="parsely-pub-date"]',
        'meta[itemprop="datePublished"]',
        'meta[name="date"]'
      ])
        || extractPublishedDateFromStructuredData(structuredData)
        || extractTimeElement()
    );

    return {
      author,
      publishedDate
    };
  }

  function getMetaContent(selectors) {
    for (const selector of selectors) {
      const value = document.querySelector(selector)?.getAttribute("content")?.trim();
      if (value) {
        return value;
      }
    }

    return "";
  }

  function extractVisibleText(selectors) {
    for (const selector of selectors) {
      const elements = Array.from(document.querySelectorAll(selector)).filter(isProbablyVisible);
      for (const element of elements) {
        const text = normalizeLineText(element.textContent ?? "");
        if (text && text.length <= 120) {
          return text;
        }
      }
    }

    return "";
  }

  function extractTimeElement() {
    const timeElement = document.querySelector('time[datetime], [itemprop="datePublished"][datetime]');
    return timeElement?.getAttribute("datetime")?.trim() || "";
  }

  function parseStructuredData() {
    return Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
      .flatMap((node) => {
        try {
          const parsed = JSON.parse(node.textContent || "null");
          return Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          return [];
        }
      })
      .filter(Boolean);
  }

  function extractAuthorFromStructuredData(records) {
    for (const record of records) {
      const author = readAuthorFromRecord(record);
      if (author) {
        return author;
      }
    }

    return "";
  }

  function readAuthorFromRecord(record) {
    if (!record || typeof record !== "object") {
      return "";
    }

    if (Array.isArray(record.author)) {
      for (const authorEntry of record.author) {
        const value = readAuthorFromRecord(authorEntry);
        if (value) {
          return value;
        }
      }
    }

    if (typeof record.author === "object" && record.author) {
      const value = readAuthorFromRecord(record.author);
      if (value) {
        return value;
      }
    }

    if (typeof record.name === "string" && String(record["@type"] || "").toLowerCase().includes("person")) {
      return record.name;
    }

    if (Array.isArray(record["@graph"])) {
      return extractAuthorFromStructuredData(record["@graph"]);
    }

    return "";
  }

  function extractPublishedDateFromStructuredData(records) {
    for (const record of records) {
      const value = readPublishedDateFromRecord(record);
      if (value) {
        return value;
      }
    }

    return "";
  }

  function readPublishedDateFromRecord(record) {
    if (!record || typeof record !== "object") {
      return "";
    }

    for (const key of ["datePublished", "dateCreated", "uploadDate", "dateModified"]) {
      if (typeof record[key] === "string" && record[key].trim()) {
        return record[key].trim();
      }
    }

    if (Array.isArray(record["@graph"])) {
      return extractPublishedDateFromStructuredData(record["@graph"]);
    }

    return "";
  }

  function normalizeAuthorName(value) {
    const text = normalizeLineText(String(value || "").replace(/^by\s+/i, ""));
    return text || "";
  }

  function normalizePublishedDate(value) {
    const text = String(value || "").trim();
    if (!text) {
      return "";
    }

    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? text : parsed.toISOString();
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

async function updateReadwiseDocument(documentId, patch, token) {
  const response = await fetch(`https://readwise.io/api/v3/update/${documentId}/`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Token ${token}`
    },
    body: JSON.stringify(patch)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Readwise update failed (${response.status}): ${errorText}`);
  }

  return response.json();
}

function buildSavePayload(snapshot, settings, sourceUrl = snapshot.url, options = {}) {
  const titlePrefix = settings.titlePrefix ?? DEFAULT_TITLE_PREFIX;
  const configuredTags = normalizeTags(settings.defaultTags) ?? DEFAULT_TAGS;
  const captureMode = settings.captureMode ?? DEFAULT_CAPTURE_MODE;
  const originalUrl = snapshot.url;
  const author = snapshot.metadata?.author || deriveAuthorName(originalUrl);
  const publishedDate = snapshot.metadata?.publishedDate || "";
  const displayTitle = `${titlePrefix}${snapshot.title}`.trim();
  const ingestTitle = `${titlePrefix}${snapshot.parserTitle || snapshot.title}`.trim();
  const rawHtml = captureMode === "html"
    ? selectHtmlSnapshot(snapshot, settings.htmlScope)
    : buildTextSnapshotHtml(snapshot.title, snapshot.contentBlocks, snapshot.filteredText || snapshot.visibleText);
  const retitledHtml = rewriteHtmlTitle(rawHtml, snapshot.parserTitle || snapshot.title);
  const html = options.useFallbackSource
    ? injectOriginalArticleLink(retitledHtml, originalUrl)
    : retitledHtml;
  const shouldCleanHtml = captureMode === "html" || settings.forceReaderClean === true;

  const payload = {
    url: sourceUrl,
    title: ingestTitle,
    author,
    html,
    should_clean_html: shouldCleanHtml,
    category: "article",
    saved_using: "readwise-save-translated-extension"
  };

  if (options.useFallbackSource) {
    payload.notes = `Original URL: ${originalUrl}`;
  }

  if (configuredTags.length > 0) {
    payload.tags = configuredTags;
  }

  if (publishedDate) {
    payload.published_date = publishedDate;
  }

  return {
    payload,
    displayTitle,
    ingestTitle
  };
}

async function loadResolvedSettings(includeLastSaveResult) {
  const storageKeys = [
    "readwiseToken",
    "titlePrefix",
    "defaultTags",
    "captureMode",
    "redirectMode",
    "redirectModeExplicit",
    "redirectConfigs",
    "redirectBaseUrl",
    "redirectServiceUrl",
    "redirectSigningSecret"
  ];
  if (includeLastSaveResult) {
    storageKeys.push(LAST_SAVE_RESULT_KEY);
  }

  const [storageSettings, fileSettings] = await Promise.all([
    chrome.storage.local.get(storageKeys),
    loadFileSettings()
  ]);

  const resolvedRedirectConfigs = resolveRedirectConfigsState(storageSettings, fileSettings);
  const resolvedRedirectMode = resolvePreferredRedirectMode(storageSettings, fileSettings, resolvedRedirectConfigs);
  const activeRedirectFields = getActiveRedirectFields(resolvedRedirectMode, resolvedRedirectConfigs);

  return {
    readwiseToken: storageSettings.readwiseToken || fileSettings.readwiseToken || "",
    titlePrefix: storageSettings.titlePrefix ?? fileSettings.titlePrefix ?? DEFAULT_TITLE_PREFIX,
    defaultTags: normalizeTags(storageSettings.defaultTags)
      ?? normalizeTags(fileSettings.defaultTags)
      ?? DEFAULT_TAGS,
    captureMode: normalizeCaptureMode(storageSettings.captureMode)
      ?? normalizeCaptureMode(fileSettings.captureMode)
      ?? DEFAULT_CAPTURE_MODE,
    redirectMode: resolvedRedirectMode,
    redirectConfigs: resolvedRedirectConfigs,
    redirectBaseUrl: activeRedirectFields.redirectBaseUrl,
    redirectServiceUrl: activeRedirectFields.redirectServiceUrl,
    redirectSigningSecret: activeRedirectFields.redirectSigningSecret,
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
          : "default",
      redirectMode: storageSettings.redirectMode != null
        ? "extension"
        : fileSettings.redirectMode != null
          ? "file"
          : "default",
      redirectBaseUrl: getRedirectFieldSource(storageSettings, fileSettings, resolvedRedirectMode, "redirectBaseUrl"),
      redirectServiceUrl: getRedirectFieldSource(storageSettings, fileSettings, resolvedRedirectMode, "redirectServiceUrl"),
      redirectSigningSecret: getRedirectFieldSource(storageSettings, fileSettings, resolvedRedirectMode, "redirectSigningSecret")
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

function areSameTags(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) {
    return false;
  }

  return left.length === right.length && left.every((tag, index) => tag === right[index]);
}

function normalizeCaptureMode(value) {
  return value === "html" || value === "text" ? value : null;
}

function normalizeRedirectMode(value) {
  return [
    REDIRECT_MODE_SYNTHETIC,
    REDIRECT_MODE_LOCAL_SIGNING,
    REDIRECT_MODE_SERVICE_SIGNING,
    REDIRECT_MODE_DIRECT_UNSAFE
  ].includes(value)
    ? value
    : null;
}

function createDefaultRedirectConfigs() {
  return {
    [REDIRECT_MODE_LOCAL_SIGNING]: {
      redirectBaseUrl: "",
      redirectSigningSecret: ""
    },
    [REDIRECT_MODE_SERVICE_SIGNING]: {
      redirectServiceUrl: ""
    },
    [REDIRECT_MODE_DIRECT_UNSAFE]: {
      redirectBaseUrl: ""
    }
  };
}

function normalizeRedirectBaseUrlValue(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return null;
  }

  try {
    return normalizeRedirectBaseUrl(trimmed);
  } catch {
    return null;
  }
}

function normalizeRedirectServiceUrlValue(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return null;
  }

  try {
    const url = new URL(trimmed);
    if (!/^https?:$/i.test(url.protocol)) {
      return null;
    }

    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function normalizeRedirectConfigsValue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const normalized = createDefaultRedirectConfigs();
  const localSigning = value[REDIRECT_MODE_LOCAL_SIGNING];
  const serviceSigning = value[REDIRECT_MODE_SERVICE_SIGNING];
  const directUnsafe = value[REDIRECT_MODE_DIRECT_UNSAFE];

  if (localSigning && typeof localSigning === "object") {
    normalized[REDIRECT_MODE_LOCAL_SIGNING].redirectBaseUrl = normalizeRedirectBaseUrlValue(localSigning.redirectBaseUrl) ?? "";
    normalized[REDIRECT_MODE_LOCAL_SIGNING].redirectSigningSecret = String(localSigning.redirectSigningSecret || "").trim();
  }

  if (serviceSigning && typeof serviceSigning === "object") {
    normalized[REDIRECT_MODE_SERVICE_SIGNING].redirectServiceUrl = normalizeRedirectServiceUrlValue(serviceSigning.redirectServiceUrl) ?? "";
  }

  if (directUnsafe && typeof directUnsafe === "object") {
    normalized[REDIRECT_MODE_DIRECT_UNSAFE].redirectBaseUrl = normalizeRedirectBaseUrlValue(directUnsafe.redirectBaseUrl) ?? "";
  }

  return hasAnyRedirectConfigInConfigs(normalized) ? normalized : null;
}

function deriveLegacyRedirectConfigs(source) {
  const inferredMode = inferRedirectMode(source);

  if (inferredMode === DEFAULT_REDIRECT_MODE) {
    return null;
  }

  const normalized = createDefaultRedirectConfigs();

  if (inferredMode === REDIRECT_MODE_LOCAL_SIGNING) {
    normalized[REDIRECT_MODE_LOCAL_SIGNING].redirectBaseUrl = normalizeRedirectBaseUrlValue(source?.redirectBaseUrl) ?? "";
    normalized[REDIRECT_MODE_LOCAL_SIGNING].redirectSigningSecret = String(source?.redirectSigningSecret || "").trim();
  } else if (inferredMode === REDIRECT_MODE_SERVICE_SIGNING) {
    normalized[REDIRECT_MODE_SERVICE_SIGNING].redirectServiceUrl = normalizeRedirectServiceUrlValue(source?.redirectServiceUrl) ?? "";
  } else if (inferredMode === REDIRECT_MODE_DIRECT_UNSAFE) {
    normalized[REDIRECT_MODE_DIRECT_UNSAFE].redirectBaseUrl = normalizeRedirectBaseUrlValue(source?.redirectBaseUrl) ?? "";
  }

  return normalized;
}

function hasAnyRedirectConfigInConfigs(configs) {
  return Boolean(
    String(configs?.[REDIRECT_MODE_LOCAL_SIGNING]?.redirectBaseUrl || "").trim()
    || String(configs?.[REDIRECT_MODE_LOCAL_SIGNING]?.redirectSigningSecret || "").trim()
    || String(configs?.[REDIRECT_MODE_SERVICE_SIGNING]?.redirectServiceUrl || "").trim()
    || String(configs?.[REDIRECT_MODE_DIRECT_UNSAFE]?.redirectBaseUrl || "").trim()
  );
}

function mergeRedirectConfigs(base, override) {
  const merged = {
    ...base,
    [REDIRECT_MODE_LOCAL_SIGNING]: {
      ...base[REDIRECT_MODE_LOCAL_SIGNING]
    },
    [REDIRECT_MODE_SERVICE_SIGNING]: {
      ...base[REDIRECT_MODE_SERVICE_SIGNING]
    },
    [REDIRECT_MODE_DIRECT_UNSAFE]: {
      ...base[REDIRECT_MODE_DIRECT_UNSAFE]
    }
  };

  if (!override) {
    return merged;
  }

  for (const mode of [REDIRECT_MODE_LOCAL_SIGNING, REDIRECT_MODE_SERVICE_SIGNING, REDIRECT_MODE_DIRECT_UNSAFE]) {
    if (!override[mode]) {
      continue;
    }

    merged[mode] = {
      ...merged[mode],
      ...override[mode]
    };
  }

  return merged;
}

function resolveRedirectConfigsState(storageSettings, fileSettings) {
  return mergeRedirectConfigs(
    mergeRedirectConfigs(
      createDefaultRedirectConfigs(),
      resolveSourceRedirectConfigs(fileSettings)
    ),
    resolveSourceRedirectConfigs(storageSettings)
  );
}

function resolveSourceRedirectConfigs(source) {
  return normalizeRedirectConfigsValue(source?.redirectConfigs)
    ?? deriveLegacyRedirectConfigs(source);
}

function hasAnyRedirectConfigSource(source) {
  return Boolean(
    normalizeRedirectConfigsValue(source?.redirectConfigs)
    || deriveLegacyRedirectConfigs(source)
  );
}

function inferRedirectMode({ redirectBaseUrl, redirectServiceUrl, redirectSigningSecret } = {}) {
  if (normalizeRedirectServiceUrlValue(redirectServiceUrl)) {
    return REDIRECT_MODE_SERVICE_SIGNING;
  }

  if (normalizeRedirectBaseUrlValue(redirectBaseUrl) && String(redirectSigningSecret || "").trim()) {
    return REDIRECT_MODE_LOCAL_SIGNING;
  }

  if (normalizeRedirectBaseUrlValue(redirectBaseUrl)) {
    return REDIRECT_MODE_DIRECT_UNSAFE;
  }

  return DEFAULT_REDIRECT_MODE;
}

function inferRedirectModeFromConfigs(configs) {
  if (String(configs?.[REDIRECT_MODE_SERVICE_SIGNING]?.redirectServiceUrl || "").trim()) {
    return REDIRECT_MODE_SERVICE_SIGNING;
  }

  if (
    String(configs?.[REDIRECT_MODE_LOCAL_SIGNING]?.redirectBaseUrl || "").trim()
    && String(configs?.[REDIRECT_MODE_LOCAL_SIGNING]?.redirectSigningSecret || "").trim()
  ) {
    return REDIRECT_MODE_LOCAL_SIGNING;
  }

  if (String(configs?.[REDIRECT_MODE_DIRECT_UNSAFE]?.redirectBaseUrl || "").trim()) {
    return REDIRECT_MODE_DIRECT_UNSAFE;
  }

  return DEFAULT_REDIRECT_MODE;
}

function resolvePreferredRedirectMode(storageSettings, fileSettings, redirectConfigs) {
  const storageMode = normalizeRedirectMode(storageSettings?.redirectMode);
  const fileMode = normalizeRedirectMode(fileSettings?.redirectMode);
  const storageModeExplicit = storageSettings?.redirectModeExplicit === true;

  if (storageModeExplicit && storageMode) {
    return storageMode;
  }

  if (hasAnyRedirectConfigSource(storageSettings)) {
    return storageMode ?? inferRedirectModeFromConfigs(redirectConfigs);
  }

  if (fileMode && (fileMode !== DEFAULT_REDIRECT_MODE || hasAnyRedirectConfigSource(fileSettings))) {
    return fileMode;
  }

  if (hasAnyRedirectConfigSource(fileSettings)) {
    return inferRedirectModeFromConfigs(redirectConfigs);
  }

  return DEFAULT_REDIRECT_MODE;
}

function getActiveRedirectFields(mode, configs) {
  const selectedMode = normalizeRedirectMode(mode) ?? DEFAULT_REDIRECT_MODE;
  const source = configs || createDefaultRedirectConfigs();

  if (selectedMode === REDIRECT_MODE_LOCAL_SIGNING) {
    return {
      redirectBaseUrl: source[REDIRECT_MODE_LOCAL_SIGNING]?.redirectBaseUrl || "",
      redirectServiceUrl: "",
      redirectSigningSecret: source[REDIRECT_MODE_LOCAL_SIGNING]?.redirectSigningSecret || ""
    };
  }

  if (selectedMode === REDIRECT_MODE_SERVICE_SIGNING) {
    return {
      redirectBaseUrl: "",
      redirectServiceUrl: source[REDIRECT_MODE_SERVICE_SIGNING]?.redirectServiceUrl || "",
      redirectSigningSecret: ""
    };
  }

  if (selectedMode === REDIRECT_MODE_DIRECT_UNSAFE) {
    return {
      redirectBaseUrl: source[REDIRECT_MODE_DIRECT_UNSAFE]?.redirectBaseUrl || "",
      redirectServiceUrl: "",
      redirectSigningSecret: ""
    };
  }

  return {
    redirectBaseUrl: "",
    redirectServiceUrl: "",
    redirectSigningSecret: ""
  };
}

function getRedirectFieldSource(storageSettings, fileSettings, mode, fieldName) {
  const selectedMode = normalizeRedirectMode(mode) ?? DEFAULT_REDIRECT_MODE;
  const storageConfigs = normalizeRedirectConfigsValue(storageSettings.redirectConfigs);
  const fileConfigs = normalizeRedirectConfigsValue(fileSettings.redirectConfigs);

  if (selectedMode !== DEFAULT_REDIRECT_MODE) {
    if (storageConfigs?.[selectedMode]?.[fieldName]) {
      return "extension";
    }

    if (fileConfigs?.[selectedMode]?.[fieldName]) {
      return "file";
    }
  }

  if (fieldName === "redirectBaseUrl") {
    if (storageSettings.redirectBaseUrl != null) {
      return "extension";
    }

    if (fileSettings.redirectBaseUrl != null) {
      return "file";
    }
  }

  if (fieldName === "redirectServiceUrl") {
    if (storageSettings.redirectServiceUrl != null) {
      return "extension";
    }

    if (fileSettings.redirectServiceUrl != null) {
      return "file";
    }
  }

  if (fieldName === "redirectSigningSecret") {
    if (storageSettings.redirectSigningSecret) {
      return "extension";
    }

    if (fileSettings.redirectSigningSecret) {
      return "file";
    }
  }

  return "default";
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

function rewriteHtmlTitle(html, title) {
  if (!html || !title) {
    return html;
  }

  const escapedTitle = escapeHtml(title);
  let updated = String(html);
  let titleApplied = false;

  if (/<title[\s>]/i.test(updated)) {
    updated = updated.replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, `<title>${escapedTitle}</title>`);
    titleApplied = true;
  }

  const replaceMeta = (pattern, replacement) => {
    if (pattern.test(updated)) {
      updated = updated.replace(pattern, replacement);
      return true;
    }

    return false;
  };

  const ogApplied = replaceMeta(
    /<meta\b[^>]*property=["']og:title["'][^>]*content=["'][^"']*["'][^>]*>/i,
    `<meta property="og:title" content="${escapedTitle}">`
  );
  const twitterApplied = replaceMeta(
    /<meta\b[^>]*name=["']twitter:title["'][^>]*content=["'][^"']*["'][^>]*>/i,
    `<meta name="twitter:title" content="${escapedTitle}">`
  );

  if (/<\/head>/i.test(updated)) {
    const injected = [
      titleApplied ? "" : `<title>${escapedTitle}</title>`,
      ogApplied ? "" : `<meta property="og:title" content="${escapedTitle}">`,
      twitterApplied ? "" : `<meta name="twitter:title" content="${escapedTitle}">`
    ]
      .filter(Boolean)
      .join("");

    if (injected) {
      updated = updated.replace(/<\/head>/i, `${injected}</head>`);
    }
  }

  return updated;
}

function injectOriginalArticleLink(html, originalUrl) {
  if (!html || !originalUrl) {
    return html;
  }

  const escapedUrl = escapeHtml(originalUrl);
  const banner = [
    '<section data-readwise-original-link="true">',
    "<p>",
    `<a href="${escapedUrl}">Open original article</a>`,
    "</p>",
    "</section>"
  ].join("");
  let updated = String(html);

  const targetPatterns = [
    /<article\b[^>]*>/i,
    /<main\b[^>]*>/i,
    /<body\b[^>]*>/i
  ];

  for (const pattern of targetPatterns) {
    if (pattern.test(updated)) {
      return updated.replace(pattern, (match) => `${match}${banner}`);
    }
  }

  return `${banner}${updated}`;
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

async function buildFallbackSourceUrl(originalUrl, settings) {
  const redirectMode = normalizeRedirectMode(settings?.redirectMode) ?? DEFAULT_REDIRECT_MODE;
  const redirectBaseUrl = settings?.redirectBaseUrl || "";
  const redirectServiceUrl = settings?.redirectServiceUrl || "";
  const redirectSigningSecret = settings?.redirectSigningSecret || "";

  if (redirectMode === REDIRECT_MODE_LOCAL_SIGNING) {
    if (!redirectBaseUrl || !redirectSigningSecret) {
      throw new Error("Extension-built redirect mode requires both a redirect base URL and a redirect signing secret.");
    }

    return {
      sourceUrl: await buildSignedRedirectUrl(redirectBaseUrl, originalUrl, redirectSigningSecret),
      strategy: REDIRECT_MODE_LOCAL_SIGNING
    };
  }

  if (redirectMode === REDIRECT_MODE_SERVICE_SIGNING) {
    if (!redirectServiceUrl) {
      throw new Error("Service-built redirect mode requires a redirect service URL.");
    }

    return {
      sourceUrl: await requestRedirectFromService(redirectServiceUrl, originalUrl),
      strategy: REDIRECT_MODE_SERVICE_SIGNING
    };
  }

  if (redirectMode === REDIRECT_MODE_DIRECT_UNSAFE) {
    if (!redirectBaseUrl) {
      throw new Error("Direct redirect mode requires a redirect base URL.");
    }

    return {
      sourceUrl: buildUnsignedRedirectUrl(redirectBaseUrl, originalUrl),
      strategy: REDIRECT_MODE_DIRECT_UNSAFE
    };
  }

  return {
    sourceUrl: buildSyntheticUrl(originalUrl),
    strategy: REDIRECT_MODE_SYNTHETIC
  };
}

async function requestRedirectFromService(serviceUrl, originalUrl) {
  const normalizedServiceUrl = normalizeRedirectServiceUrlValue(serviceUrl);
  if (!normalizedServiceUrl) {
    throw new Error("Redirect service URL is not a valid http(s) URL.");
  }

  const response = await fetch(normalizedServiceUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      originalUrl,
      version: REDIRECT_VERSION,
      client: {
        extensionVersion: EXTENSION_VERSION,
        mode: "fallback"
      }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Redirect service request failed (${response.status}): ${errorText}`);
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error("Redirect service returned invalid JSON.");
  }

  const redirectUrl = String(body?.redirectUrl || "").trim();
  if (!body?.ok || !redirectUrl) {
    throw new Error("Redirect service did not return a redirectUrl.");
  }

  try {
    const parsed = new URL(redirectUrl);
    if (!/^https?:$/i.test(parsed.protocol)) {
      throw new Error("Redirect service returned a non-http URL.");
    }
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "Redirect service returned an invalid URL.");
  }

  return redirectUrl;
}

function isRedirectSourceStrategy(sourceStrategy) {
  return [
    REDIRECT_MODE_LOCAL_SIGNING,
    REDIRECT_MODE_SERVICE_SIGNING,
    REDIRECT_MODE_DIRECT_UNSAFE
  ].includes(sourceStrategy);
}

function buildSyntheticUrl(originalUrl) {
  const timestamp = Date.now();
  const hash = simpleHash(originalUrl);
  const nonce = Math.random().toString(36).slice(2, 8);
  const slug = buildUrlSlug(originalUrl);
  return `https://translated.local/readwise-snapshot/${slug}-${timestamp}-${hash}-${nonce}`;
}

function buildUrlSlug(originalUrl) {
  try {
    const url = new URL(originalUrl);
    return `${sanitizeSlugPart(url.hostname)}-${sanitizeSlugPart(url.pathname)}`.replace(/^-+|-+$/g, "") || "snapshot";
  } catch {
    return "snapshot";
  }
}

function sanitizeSlugPart(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function simpleHash(value) {
  let hash = 0;
  for (const char of String(value)) {
    hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  }

  return Math.abs(hash).toString(36);
}

function deriveAuthorName(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "translated-page";
  }
}

async function withBadge(tabId, text, color, work) {
  await clearStoredTabActionState(tabId);
  if (await isTabCurrentlyActive(tabId)) {
    await setVisibleActionIcon("default");
    await setVisibleActionTitle(DEFAULT_ACTION_TITLE);
  }
  await setBadge(tabId, text, color);

  try {
    return await work();
  } finally {
    if (tabId) {
      await clearBadge(tabId);
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

async function clearBadge(tabId) {
  if (!tabId) {
    return;
  }

  await chrome.action.setBadgeText({ tabId, text: "" });
}

async function setVisibleActionIcon(state = "default") {
  const path = state === "success"
    ? SUCCESS_ACTION_ICON_PATHS
    : state === "error"
      ? ERROR_ACTION_ICON_PATHS
      : DEFAULT_ACTION_ICON_PATHS;

  await chrome.action.setIcon({ path });
}

async function setVisibleActionTitle(title = DEFAULT_ACTION_TITLE) {
  await chrome.action.setTitle({ title });
}

async function resetTabActionState(tabId) {
  if (!tabId) {
    return;
  }

  try {
    await clearStoredTabActionState(tabId);
    await clearBadge(tabId);
    if (await isTabCurrentlyActive(tabId)) {
      await setVisibleActionIcon("default");
      await setVisibleActionTitle(DEFAULT_ACTION_TITLE);
    }
  } catch {
    // Ignore reset failures for tabs that no longer exist.
  }
}

async function syncFocusedWindowActionState(windowId = chrome.windows.WINDOW_ID_CURRENT) {
  try {
    const tabs = await chrome.tabs.query({
      active: true,
      windowId
    });
    const activeTab = tabs[0];
    if (activeTab?.id) {
      await syncActionStateForTab(activeTab.id);
    }
  } catch {
    // Ignore sync failures for windows that are no longer available.
  }
}

async function syncActionStateForTab(tabId) {
  if (!tabId) {
    return;
  }

  const storedState = await getStoredTabActionState(tabId);

  if (!storedState) {
    await clearBadge(tabId);
    await setVisibleActionIcon("default");
    await setVisibleActionTitle(DEFAULT_ACTION_TITLE);
    return;
  }

  await clearBadge(tabId);
  await setVisibleActionIcon(storedState.state);
  await setVisibleActionTitle(storedState.title || DEFAULT_ACTION_TITLE);
}

async function getStoredTabActionState(tabId) {
  if (!tabId) {
    return null;
  }

  const { [TAB_ACTION_STATES_KEY]: rawStates } = await chrome.storage.session.get([TAB_ACTION_STATES_KEY]);
  const states = rawStates && typeof rawStates === "object" ? rawStates : {};
  return states[String(tabId)] ?? null;
}

async function storeTabActionState(tabId, state) {
  if (!tabId) {
    return;
  }

  const { [TAB_ACTION_STATES_KEY]: rawStates } = await chrome.storage.session.get([TAB_ACTION_STATES_KEY]);
  const states = rawStates && typeof rawStates === "object" ? rawStates : {};
  states[String(tabId)] = state;
  await chrome.storage.session.set({ [TAB_ACTION_STATES_KEY]: states });
}

async function clearStoredTabActionState(tabId) {
  if (!tabId) {
    return;
  }

  const { [TAB_ACTION_STATES_KEY]: rawStates } = await chrome.storage.session.get([TAB_ACTION_STATES_KEY]);
  const states = rawStates && typeof rawStates === "object" ? rawStates : {};
  if (!(String(tabId) in states)) {
    return;
  }

  delete states[String(tabId)];
  await chrome.storage.session.set({ [TAB_ACTION_STATES_KEY]: states });
}

async function isTabCurrentlyActive(tabId) {
  if (!tabId) {
    return false;
  }

  try {
    const tab = await chrome.tabs.get(tabId);
    return Boolean(tab.active);
  } catch {
    return false;
  }
}

function buildSuccessActionTitle(resultSummary) {
  switch (resultSummary.sourceStrategy) {
    case REDIRECT_MODE_LOCAL_SIGNING:
      return "Saved translated fallback version with an extension-built redirect link.";
    case REDIRECT_MODE_SERVICE_SIGNING:
      return "Saved translated fallback version with a service-built redirect link.";
    case REDIRECT_MODE_DIRECT_UNSAFE:
      return "Saved translated fallback version with a direct redirect link.";
    case REDIRECT_MODE_SYNTHETIC:
      return "Saved translated fallback version with a placeholder Reader source URL.";
  }

  if (resultSummary.existingDocumentDetected) {
    return "Saved translated variant. This URL already existed in Readwise.";
  }

  return "Saved translated version to Readwise.";
}

function buildErrorActionTitle(message) {
  const normalized = String(message || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= 140) {
    return `Readwise save failed: ${normalized}`;
  }

  return `Readwise save failed: ${normalized.slice(0, 117)}...`;
}
