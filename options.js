const form = document.querySelector("#settings-form");
const tokenInput = document.querySelector("#token");
const titlePrefixInput = document.querySelector("#title-prefix");
const tagsInput = document.querySelector("#tags");
const captureModeInput = document.querySelector("#capture-mode");
const redirectBaseUrlInput = document.querySelector("#redirect-base-url");
const redirectSigningSecretInput = document.querySelector("#redirect-signing-secret");
const restoreRedirectBaseUrlButton = document.querySelector("#restore-redirect-base-url");
const statusNode = document.querySelector("#status");
const configSourceNode = document.querySelector("#config-source");
const FILE_CONFIG_PATH = "config.local.json";
const DEFAULT_REDIRECT_BASE_URL = "https://go.example.com";

void loadSettings();

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const validationError = validateForm();
  if (validationError) {
    setStatus(validationError, "error");
    return;
  }

  const titlePrefix = titlePrefixInput.value;
  const defaultTags = tagsInput.value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);

  await chrome.storage.local.set({
    readwiseToken: tokenInput.value.trim(),
    titlePrefix,
    defaultTags,
    captureMode: captureModeInput.value === "text" ? "text" : "html",
    redirectBaseUrl: redirectBaseUrlInput.value.trim(),
    redirectSigningSecret: redirectSigningSecretInput.value.trim()
  });

  setStatus("Saved.", "success");
});

restoreRedirectBaseUrlButton.addEventListener("click", () => {
  redirectBaseUrlInput.value = DEFAULT_REDIRECT_BASE_URL;
  setStatus("Default redirect domain restored.", "success");
});

async function loadSettings() {
  const [settings, fileSettings] = await Promise.all([
    chrome.storage.local.get([
      "readwiseToken",
      "titlePrefix",
      "defaultTags",
      "captureMode",
      "redirectBaseUrl",
      "redirectSigningSecret"
    ]),
    loadFileSettings()
  ]);

  const resolvedToken = settings.readwiseToken || fileSettings.readwiseToken || "";
  const resolvedTitlePrefix = settings.titlePrefix ?? fileSettings.titlePrefix ?? "";
  const resolvedTags = Array.isArray(settings.defaultTags)
    ? settings.defaultTags
    : Array.isArray(fileSettings.defaultTags)
      ? fileSettings.defaultTags
      : [];
  const resolvedCaptureMode = settings.captureMode === "html" || settings.captureMode === "text"
    ? settings.captureMode
    : fileSettings.captureMode === "html" || fileSettings.captureMode === "text"
      ? fileSettings.captureMode
      : "html";
  const resolvedRedirectBaseUrl = settings.redirectBaseUrl ?? fileSettings.redirectBaseUrl ?? DEFAULT_REDIRECT_BASE_URL;
  const resolvedRedirectSigningSecret = settings.redirectSigningSecret || fileSettings.redirectSigningSecret || "";

  tokenInput.value = resolvedToken;
  titlePrefixInput.value = resolvedTitlePrefix;
  tagsInput.value = resolvedTags.join(", ");
  captureModeInput.value = resolvedCaptureMode;
  redirectBaseUrlInput.value = resolvedRedirectBaseUrl;
  redirectSigningSecretInput.value = resolvedRedirectSigningSecret;

  if (
    fileSettings.readwiseToken ||
    fileSettings.titlePrefix ||
    Array.isArray(fileSettings.defaultTags) ||
    fileSettings.captureMode ||
    fileSettings.redirectBaseUrl ||
    fileSettings.redirectSigningSecret
  ) {
    configSourceNode.textContent = "File config detected. Reload the unpacked extension after editing config.local.json. You can restore the built-in redirect domain from this page at any time.";
  } else {
    configSourceNode.textContent = "The redirect domain field already points at the built-in jump-back domain. Change it only if you run your own redirect service.";
  }
}

function validateForm() {
  const redirectBaseUrl = redirectBaseUrlInput.value.trim();

  if (!redirectBaseUrl) {
    return "Redirect base URL cannot be empty. Restore the default domain or enter your own.";
  }

  try {
    const url = new URL(redirectBaseUrl);
    if (!/^https?:$/i.test(url.protocol)) {
      return "Redirect base URL must use http or https.";
    }
  } catch {
    return "Redirect base URL is not a valid URL.";
  }

  return "";
}

function setStatus(message, state = "") {
  statusNode.textContent = message;
  statusNode.dataset.state = state;

  window.clearTimeout(setStatus.timeoutId);
  setStatus.timeoutId = window.setTimeout(() => {
    statusNode.textContent = "";
    statusNode.dataset.state = "";
  }, 2500);
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
