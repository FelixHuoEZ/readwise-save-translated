const SAVE_ENDPOINT = "https://readwise.io/api/v3/save/";
const FILE_CONFIG_PATH = "config.local.json";
const LEGACY_TITLE_PREFIX = "[ZH] ";
const DEFAULT_TITLE_PREFIX = "";
const LEGACY_DEFAULT_TAGS = ["translated", "snapshot", "lang:zh", "chrome-extension"];
const DEFAULT_TAGS = [];
const DEFAULT_CAPTURE_MODE = "html";
const DEFAULT_HTML_SCOPE = "whole-page";
const BADGE_RESET_DELAY_MS = 5000;
const LAST_SAVE_RESULT_KEY = "lastSaveResult";
const DETAILS_MENU_ID = "open-details";
const DEFAULT_ACTION_TITLE = "Left click: save article-only. Right click: open details.";
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

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await chrome.storage.local.get([
    "readwiseToken",
    "titlePrefix",
    "defaultTags",
    "captureMode"
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

  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }

  await migrateLegacyTitlePrefix();
  await ensureContextMenus();
  await setActionIcon(null, "default");
  await setActionTitle(null, DEFAULT_ACTION_TITLE);
});

chrome.runtime.onStartup.addListener(() => {
  void ensureContextMenus();
  void migrateLegacyDefaultTags();
  void migrateLegacyTitlePrefix();
  void setActionIcon(null, "default");
  void setActionTitle(null, DEFAULT_ACTION_TITLE);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" || typeof changeInfo.url === "string") {
    void resetTabActionState(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void resetTabActionState(tabId);
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
      let existingDocumentDetected = false;
      let existingDocumentUrl = null;
      let existingDocumentId = null;

      if (saveResult.status === 200) {
        existingDocumentDetected = true;
        existingDocumentUrl = saveResult.body?.url ?? null;
        existingDocumentId = saveResult.body?.id ?? null;
        const fallbackPayload = buildSavePayload(snapshot, settings, addTranslatedFragment(snapshot.url));
        saveResult = await saveToReadwise(fallbackPayload, settings.readwiseToken);
        usedFallbackUrl = true;
      }

      const resultSummary = {
        savedAt: new Date().toISOString(),
        pageTitle: snapshot.title,
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
        usedFallbackUrl,
        status: "success"
      };

      await chrome.storage.local.set({ [LAST_SAVE_RESULT_KEY]: resultSummary });
      await clearBadge(tab.id);
      await setActionIcon(tab.id, "success");
      await setActionTitle(tab.id, buildSuccessActionTitle(resultSummary));
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
      existingDocumentDetected: false,
      existingDocumentUrl: null,
      existingDocumentId: null,
      originalTitle: null,
      translatedTitle: null,
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
      usedFallbackUrl: false,
      status: "error",
      error: error.message
    };

    await chrome.storage.local.set({ [LAST_SAVE_RESULT_KEY]: failureSummary });
    console.error(error);

    if (!error.message.startsWith("Missing Readwise access token")) {
      await clearBadge(tab.id);
      await setActionIcon(tab.id, "error");
      await setActionTitle(tab.id, buildErrorActionTitle(error.message));
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
      url: window.location.href,
      html: document.documentElement.outerHTML,
      articleHtml: articleRoot ? buildScopedHtml(articleRoot.outerHTML, metadata, titleInfo.resolvedTitle) : null,
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

  function buildScopedHtml(contentHtml, metadata = {}, pageTitle = document.title) {
    return [
      "<!doctype html>",
      "<html>",
      "<head>",
      '  <meta charset="utf-8">',
      `  <title>${escapeHtml(pageTitle)}</title>`,
      `  <base href="${escapeHtml(window.location.href)}">`,
      `  <meta property="og:title" content="${escapeHtml(pageTitle)}">`,
      `  <meta name="twitter:title" content="${escapeHtml(pageTitle)}">`,
      metadata.author ? `  <meta name="author" content="${escapeHtml(metadata.author)}">` : "",
      metadata.publishedDate ? `  <meta property="article:published_time" content="${escapeHtml(metadata.publishedDate)}">` : "",
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

  function extractTitleInfo(articleRoot, contentRoot) {
    const heading = pickPrimaryHeading(articleRoot, contentRoot);
    const originalTitle = resolveOriginalTitle(heading);
    const translatedTitle = findTranslatedTitleNearHeading(heading, articleRoot ?? contentRoot ?? document.body);
    const resolvedTitle = buildResolvedTitle(originalTitle, translatedTitle, document.title);

    return {
      originalTitle,
      translatedTitle,
      resolvedTitle
    };
  }

  function buildResolvedTitle(originalTitle, translatedTitle, fallbackTitle) {
    const normalizedOriginal = normalizeHeadingText(originalTitle);
    const normalizedTranslated = normalizeHeadingText(translatedTitle);

    if (normalizedOriginal && normalizedTranslated) {
      const lowerOriginal = normalizedOriginal.toLowerCase();
      const lowerTranslated = normalizedTranslated.toLowerCase();
      if (lowerOriginal !== lowerTranslated) {
        return `${normalizedOriginal} ${normalizedTranslated}`;
      }
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

function buildSavePayload(snapshot, settings, sourceUrl = snapshot.url) {
  const titlePrefix = settings.titlePrefix ?? DEFAULT_TITLE_PREFIX;
  const configuredTags = normalizeTags(settings.defaultTags) ?? DEFAULT_TAGS;
  const captureMode = settings.captureMode ?? DEFAULT_CAPTURE_MODE;
  const originalUrl = snapshot.url;
  const author = snapshot.metadata?.author || deriveAuthorName(originalUrl);
  const publishedDate = snapshot.metadata?.publishedDate || "";
  const capturedAt = new Date().toISOString();
  const rawHtml = captureMode === "html"
    ? selectHtmlSnapshot(snapshot, settings.htmlScope)
    : buildTextSnapshotHtml(snapshot.title, snapshot.contentBlocks, snapshot.filteredText || snapshot.visibleText);
  const html = rewriteHtmlTitle(rawHtml, snapshot.title);
  const shouldCleanHtml = captureMode === "html" || settings.forceReaderClean === true;

  const payload = {
    url: sourceUrl,
    title: `${titlePrefix}${snapshot.title}`.trim(),
    author,
    html,
    should_clean_html: shouldCleanHtml,
    category: "article",
    saved_using: "readwise-save-translated-extension",
    notes: [
      "Saved as a translated snapshot from Chrome.",
      `Resolved title: ${snapshot.title || "not found"}`,
      `Original title: ${snapshot.originalTitle || "not found"}`,
      `Translated title: ${snapshot.translatedTitle || "not found"}`,
      `Capture mode: ${captureMode}`,
      `HTML scope: ${settings.htmlScope}`,
      `Readwise clean HTML: ${shouldCleanHtml ? "enabled" : "disabled"}`,
      `Author: ${author || "not found"}`,
      `Published date: ${publishedDate || "not found"}`,
      `Detected CJK characters: ${snapshot.detectedCjkCount}`,
      `Content root: ${snapshot.contentRootSelector}`,
      `Article root: ${snapshot.articleSelector || "not found"}`,
      `Captured blocks: ${snapshot.contentBlocks.length}`,
      `Original URL: ${originalUrl}`,
      `Reader source URL: ${sourceUrl}`,
      `Captured at: ${capturedAt}`
    ].join("\n")
  };

  if (configuredTags.length > 0) {
    payload.tags = configuredTags;
  }

  if (publishedDate) {
    payload.published_date = publishedDate;
  }

  return payload;
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

function areSameTags(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) {
    return false;
  }

  return left.length === right.length && left.every((tag, index) => tag === right[index]);
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
  await setActionIcon(tabId, "default");
  await setActionTitle(tabId, DEFAULT_ACTION_TITLE);
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

async function clearBadge(tabId) {
  if (!tabId) {
    return;
  }

  await chrome.action.setBadgeText({ tabId, text: "" });
}

async function setActionIcon(tabId = null, state = "default") {
  const path = state === "success"
    ? SUCCESS_ACTION_ICON_PATHS
    : state === "error"
      ? ERROR_ACTION_ICON_PATHS
      : DEFAULT_ACTION_ICON_PATHS;

  if (tabId) {
    await chrome.action.setIcon({ tabId, path });
    return;
  }

  await chrome.action.setIcon({ path });
}

async function setActionTitle(tabId = null, title = DEFAULT_ACTION_TITLE) {
  if (!tabId) {
    await chrome.action.setTitle({ title });
    return;
  }

  await chrome.action.setTitle({ tabId, title });
}

async function resetTabActionState(tabId) {
  if (!tabId) {
    return;
  }

  try {
    await clearBadge(tabId);
    await setActionIcon(tabId, "default");
    await setActionTitle(tabId, DEFAULT_ACTION_TITLE);
  } catch {
    // Ignore reset failures for tabs that no longer exist.
  }
}

function buildSuccessActionTitle(resultSummary) {
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
