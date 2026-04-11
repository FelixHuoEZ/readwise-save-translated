const form = document.querySelector("#settings-form");
const tokenInput = document.querySelector("#token");
const titlePrefixInput = document.querySelector("#title-prefix");
const tagsInput = document.querySelector("#tags");
const captureModeInput = document.querySelector("#capture-mode");
const redirectModeInputs = Array.from(document.querySelectorAll('input[name="redirect-mode"]'));
const redirectBaseUrlInput = document.querySelector("#redirect-base-url");
const redirectServiceUrlInput = document.querySelector("#redirect-service-url");
const redirectSigningSecretInput = document.querySelector("#redirect-signing-secret");
const redirectBaseUrlField = document.querySelector("#redirect-base-url-field");
const redirectServiceUrlField = document.querySelector("#redirect-service-url-field");
const redirectSigningSecretField = document.querySelector("#redirect-signing-secret-field");
const redirectBaseUrlRequired = document.querySelector("#redirect-base-url-required");
const redirectServiceUrlRequired = document.querySelector("#redirect-service-url-required");
const redirectSigningSecretRequired = document.querySelector("#redirect-signing-secret-required");
const redirectDirectWarning = document.querySelector("#redirect-direct-warning");
const redirectEmptyNote = document.querySelector("#redirect-empty-note");
const modeFields = document.querySelector(".mode-fields");
const statusNodes = Array.from(document.querySelectorAll("#status, #advanced-status"));
const configSourceNode = document.querySelector("#config-source");
const versionFooterNode = document.querySelector("#version-footer");
const FILE_CONFIG_PATH = "config.local.json";
const DEFAULT_REDIRECT_MODE = "synthetic";
const EXTENSION_VERSION = chrome.runtime.getManifest().version;
const REDIRECT_MODES = [
  DEFAULT_REDIRECT_MODE,
  "local-signing",
  "service-signing",
  "direct-redirect-unsafe"
];
let redirectConfigsState = createDefaultRedirectConfigs();
let activeRedirectMode = DEFAULT_REDIRECT_MODE;

void loadSettings();
renderVersionFooter();

for (const input of redirectModeInputs) {
  input.addEventListener("change", () => {
    if (!input.checked) {
      return;
    }

    switchRedirectMode(input.value);
  });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  persistCurrentRedirectModeFields();
  clearRedirectValidationState();

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
  const redirectMode = getSelectedRedirectMode();
  const redirectConfigs = serializeRedirectConfigs(redirectConfigsState);
  const activeRedirectFields = getActiveRedirectFields(redirectMode, redirectConfigs);

  await chrome.storage.local.set({
    readwiseToken: tokenInput.value.trim(),
    titlePrefix,
    defaultTags,
    captureMode: captureModeInput.value === "text" ? "text" : "html",
    redirectMode,
    redirectModeExplicit: true,
    redirectConfigs,
    redirectBaseUrl: activeRedirectFields.redirectBaseUrl,
    redirectServiceUrl: activeRedirectFields.redirectServiceUrl,
    redirectSigningSecret: activeRedirectFields.redirectSigningSecret
  });

  setStatus("Saved.", "success");
});

async function loadSettings() {
  const [settings, fileSettings] = await Promise.all([
    chrome.storage.local.get([
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

  redirectConfigsState = resolveRedirectConfigsState(settings, fileSettings);
  activeRedirectMode = resolvePreferredRedirectMode(settings, fileSettings, redirectConfigsState);

  tokenInput.value = resolvedToken;
  titlePrefixInput.value = resolvedTitlePrefix;
  tagsInput.value = resolvedTags.join(", ");
  captureModeInput.value = resolvedCaptureMode;
  setSelectedRedirectMode(activeRedirectMode);
  renderRedirectModeUi(activeRedirectMode);

  if (
    fileSettings.readwiseToken ||
    fileSettings.titlePrefix ||
    Array.isArray(fileSettings.defaultTags) ||
    fileSettings.captureMode ||
    fileSettings.redirectMode ||
    fileSettings.redirectConfigs ||
    fileSettings.redirectBaseUrl ||
    fileSettings.redirectServiceUrl ||
    fileSettings.redirectSigningSecret
  ) {
    configSourceNode.textContent = "File config detected. Reload the unpacked extension after editing config.local.json. Leave redirect mode on Placeholder source URL unless you run your own redirect setup.";
  } else {
    configSourceNode.textContent = "Leave redirect mode on Placeholder source URL unless you run your own redirect setup.";
  }
}

function validateForm() {
  const redirectMode = getSelectedRedirectMode();
  const config = redirectConfigsState[redirectMode] || {};

  if (redirectMode === DEFAULT_REDIRECT_MODE) {
    return "";
  }

  if (redirectMode === "local-signing") {
    if (!config.redirectBaseUrl || !config.redirectSigningSecret) {
      setRedirectFieldInvalid("redirectBaseUrl", !config.redirectBaseUrl);
      setRedirectFieldInvalid("redirectSigningSecret", !config.redirectSigningSecret);
      return "Extension-built redirect needs both a redirect base URL and a redirect signing secret.";
    }

    try {
      assertHttpUrl(config.redirectBaseUrl);
    } catch (error) {
      setRedirectFieldInvalid("redirectBaseUrl", true);
      return error.message;
    }

    return "";
  }

  if (redirectMode === "service-signing") {
    if (!config.redirectServiceUrl) {
      setRedirectFieldInvalid("redirectServiceUrl", true);
      return "Service-built redirect needs a redirect service URL.";
    }

    try {
      assertHttpUrl(config.redirectServiceUrl, "Redirect service URL");
    } catch (error) {
      setRedirectFieldInvalid("redirectServiceUrl", true);
      return error.message;
    }

    return "";
  }

  if (!config.redirectBaseUrl) {
    setRedirectFieldInvalid("redirectBaseUrl", true);
    return "Direct redirect needs a redirect base URL.";
  }

  try {
    assertHttpUrl(config.redirectBaseUrl);
  } catch (error) {
    setRedirectFieldInvalid("redirectBaseUrl", true);
    return error.message;
  }

  return "";
}

function setStatus(message, state = "") {
  for (const node of statusNodes) {
    if (!node) {
      continue;
    }

    node.textContent = message;
    node.dataset.state = state;
  }

  window.clearTimeout(setStatus.timeoutId);
  setStatus.timeoutId = window.setTimeout(() => {
    for (const node of statusNodes) {
      if (!node) {
        continue;
      }

      node.textContent = "";
      node.dataset.state = "";
    }
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

function renderVersionFooter() {
  if (!versionFooterNode) {
    return;
  }

  versionFooterNode.textContent = `Version ${EXTENSION_VERSION}`;
}

function getSelectedRedirectMode() {
  return redirectModeInputs.find((input) => input.checked)?.value || DEFAULT_REDIRECT_MODE;
}

function setSelectedRedirectMode(mode) {
  const normalizedMode = normalizeRedirectMode(mode) ?? DEFAULT_REDIRECT_MODE;
  for (const input of redirectModeInputs) {
    input.checked = input.value === normalizedMode;
  }
}

function switchRedirectMode(nextMode) {
  persistCurrentRedirectModeFields();
  activeRedirectMode = normalizeRedirectMode(nextMode) ?? DEFAULT_REDIRECT_MODE;
  setSelectedRedirectMode(activeRedirectMode);
  renderRedirectModeUi(activeRedirectMode);
}

function persistCurrentRedirectModeFields() {
  const mode = normalizeRedirectMode(activeRedirectMode) ?? DEFAULT_REDIRECT_MODE;

  if (mode === "local-signing") {
    redirectConfigsState[mode] = {
      redirectBaseUrl: redirectBaseUrlInput.value.trim(),
      redirectSigningSecret: redirectSigningSecretInput.value.trim()
    };
    return;
  }

  if (mode === "service-signing") {
    redirectConfigsState[mode] = {
      redirectServiceUrl: redirectServiceUrlInput.value.trim()
    };
    return;
  }

  if (mode === "direct-redirect-unsafe") {
    redirectConfigsState[mode] = {
      redirectBaseUrl: redirectBaseUrlInput.value.trim()
    };
  }
}

function renderRedirectModeUi(mode) {
  const selectedMode = normalizeRedirectMode(mode) ?? DEFAULT_REDIRECT_MODE;
  const usesBaseUrl = selectedMode === "local-signing" || selectedMode === "direct-redirect-unsafe";
  const usesServiceUrl = selectedMode === "service-signing";
  const usesSecret = selectedMode === "local-signing";
  const isDirectUnsafe = selectedMode === "direct-redirect-unsafe";
  const isPlaceholder = selectedMode === DEFAULT_REDIRECT_MODE;
  const config = redirectConfigsState[selectedMode] || {};
  const baseUrlRequired = selectedMode === "local-signing" || selectedMode === "direct-redirect-unsafe";
  const serviceUrlRequired = selectedMode === "service-signing";
  const signingSecretRequired = selectedMode === "local-signing";

  redirectDirectWarning.hidden = !isDirectUnsafe;
  redirectEmptyNote.hidden = !isPlaceholder;
  modeFields.dataset.disabled = isPlaceholder ? "true" : "false";
  redirectBaseUrlField.dataset.disabled = usesBaseUrl ? "false" : "true";
  redirectServiceUrlField.dataset.disabled = usesServiceUrl ? "false" : "true";
  redirectSigningSecretField.dataset.disabled = usesSecret ? "false" : "true";

  redirectBaseUrlInput.value = usesBaseUrl ? config.redirectBaseUrl || "" : redirectConfigsState["direct-redirect-unsafe"]?.redirectBaseUrl || redirectConfigsState["local-signing"]?.redirectBaseUrl || "";
  redirectServiceUrlInput.value = usesServiceUrl ? config.redirectServiceUrl || "" : redirectConfigsState["service-signing"]?.redirectServiceUrl || "";
  redirectSigningSecretInput.value = usesSecret ? config.redirectSigningSecret || "" : redirectConfigsState["local-signing"]?.redirectSigningSecret || "";

  redirectBaseUrlInput.disabled = !usesBaseUrl;
  redirectServiceUrlInput.disabled = !usesServiceUrl;
  redirectSigningSecretInput.disabled = !usesSecret;

  redirectBaseUrlInput.required = baseUrlRequired;
  redirectServiceUrlInput.required = serviceUrlRequired;
  redirectSigningSecretInput.required = signingSecretRequired;

  redirectBaseUrlRequired.hidden = !baseUrlRequired;
  redirectServiceUrlRequired.hidden = !serviceUrlRequired;
  redirectSigningSecretRequired.hidden = !signingSecretRequired;

  clearRedirectValidationState();
}

function clearRedirectValidationState() {
  for (const input of [redirectBaseUrlInput, redirectServiceUrlInput, redirectSigningSecretInput]) {
    input.removeAttribute("aria-invalid");
  }
}

function setRedirectFieldInvalid(field, invalid) {
  const input = field === "redirectBaseUrl"
    ? redirectBaseUrlInput
    : field === "redirectServiceUrl"
      ? redirectServiceUrlInput
      : redirectSigningSecretInput;

  if (!input || input.disabled) {
    return;
  }

  if (invalid) {
    input.setAttribute("aria-invalid", "true");
  } else {
    input.removeAttribute("aria-invalid");
  }
}

function createDefaultRedirectConfigs() {
  return {
    "local-signing": {
      redirectBaseUrl: "",
      redirectSigningSecret: ""
    },
    "service-signing": {
      redirectServiceUrl: ""
    },
    "direct-redirect-unsafe": {
      redirectBaseUrl: ""
    }
  };
}

function resolveRedirectConfigsState(settings, fileSettings) {
  const base = createDefaultRedirectConfigs();
  mergeRedirectConfigsInto(base, resolveSourceRedirectConfigs(fileSettings));
  mergeRedirectConfigsInto(base, resolveSourceRedirectConfigs(settings));
  return base;
}

function resolveSourceRedirectConfigs(source) {
  return normalizeRedirectConfigsValue(source?.redirectConfigs)
    ?? deriveLegacyRedirectConfigs(source);
}

function normalizeRedirectConfigsValue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const normalized = createDefaultRedirectConfigs();
  const localSigning = value["local-signing"];
  const serviceSigning = value["service-signing"];
  const directUnsafe = value["direct-redirect-unsafe"];

  if (localSigning && typeof localSigning === "object") {
    normalized["local-signing"].redirectBaseUrl = String(localSigning.redirectBaseUrl || "").trim();
    normalized["local-signing"].redirectSigningSecret = String(localSigning.redirectSigningSecret || "").trim();
  }

  if (serviceSigning && typeof serviceSigning === "object") {
    normalized["service-signing"].redirectServiceUrl = String(serviceSigning.redirectServiceUrl || "").trim();
  }

  if (directUnsafe && typeof directUnsafe === "object") {
    normalized["direct-redirect-unsafe"].redirectBaseUrl = String(directUnsafe.redirectBaseUrl || "").trim();
  }

  return hasAnyRedirectConfigInConfigs(normalized) ? normalized : null;
}

function deriveLegacyRedirectConfigs(source) {
  const inferredMode = inferRedirectMode({
    redirectBaseUrl: source?.redirectBaseUrl,
    redirectServiceUrl: source?.redirectServiceUrl,
    redirectSigningSecret: source?.redirectSigningSecret
  });

  if (inferredMode === DEFAULT_REDIRECT_MODE) {
    return null;
  }

  const normalized = createDefaultRedirectConfigs();

  if (inferredMode === "local-signing") {
    normalized["local-signing"].redirectBaseUrl = String(source?.redirectBaseUrl || "").trim();
    normalized["local-signing"].redirectSigningSecret = String(source?.redirectSigningSecret || "").trim();
  } else if (inferredMode === "service-signing") {
    normalized["service-signing"].redirectServiceUrl = String(source?.redirectServiceUrl || "").trim();
  } else if (inferredMode === "direct-redirect-unsafe") {
    normalized["direct-redirect-unsafe"].redirectBaseUrl = String(source?.redirectBaseUrl || "").trim();
  }

  return normalized;
}

function mergeRedirectConfigsInto(target, source) {
  if (!source) {
    return target;
  }

  for (const mode of ["local-signing", "service-signing", "direct-redirect-unsafe"]) {
    if (!source[mode] || typeof source[mode] !== "object") {
      continue;
    }

    target[mode] = {
      ...target[mode],
      ...source[mode]
    };
  }

  return target;
}

function serializeRedirectConfigs(configs) {
  const source = configs || createDefaultRedirectConfigs();
  return {
    "local-signing": {
      redirectBaseUrl: String(source["local-signing"]?.redirectBaseUrl || "").trim(),
      redirectSigningSecret: String(source["local-signing"]?.redirectSigningSecret || "").trim()
    },
    "service-signing": {
      redirectServiceUrl: String(source["service-signing"]?.redirectServiceUrl || "").trim()
    },
    "direct-redirect-unsafe": {
      redirectBaseUrl: String(source["direct-redirect-unsafe"]?.redirectBaseUrl || "").trim()
    }
  };
}

function hasAnyRedirectConfigSource(source) {
  return Boolean(
    normalizeRedirectConfigsValue(source?.redirectConfigs)
    || deriveLegacyRedirectConfigs(source)
  );
}

function hasAnyRedirectConfigInConfigs(configs) {
  return Boolean(
    String(configs?.["local-signing"]?.redirectBaseUrl || "").trim()
    || String(configs?.["local-signing"]?.redirectSigningSecret || "").trim()
    || String(configs?.["service-signing"]?.redirectServiceUrl || "").trim()
    || String(configs?.["direct-redirect-unsafe"]?.redirectBaseUrl || "").trim()
  );
}

function getActiveRedirectFields(mode, configs) {
  const selectedMode = normalizeRedirectMode(mode) ?? DEFAULT_REDIRECT_MODE;
  const source = configs || createDefaultRedirectConfigs();

  if (selectedMode === "local-signing") {
    return {
      redirectBaseUrl: source["local-signing"]?.redirectBaseUrl || "",
      redirectServiceUrl: "",
      redirectSigningSecret: source["local-signing"]?.redirectSigningSecret || ""
    };
  }

  if (selectedMode === "service-signing") {
    return {
      redirectBaseUrl: "",
      redirectServiceUrl: source["service-signing"]?.redirectServiceUrl || "",
      redirectSigningSecret: ""
    };
  }

  if (selectedMode === "direct-redirect-unsafe") {
    return {
      redirectBaseUrl: source["direct-redirect-unsafe"]?.redirectBaseUrl || "",
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

function normalizeRedirectMode(value) {
  return REDIRECT_MODES.includes(value) ? value : null;
}

function inferRedirectMode({ redirectBaseUrl, redirectServiceUrl, redirectSigningSecret } = {}) {
  if (String(redirectServiceUrl || "").trim()) {
    return "service-signing";
  }

  if (String(redirectBaseUrl || "").trim() && String(redirectSigningSecret || "").trim()) {
    return "local-signing";
  }

  if (String(redirectBaseUrl || "").trim()) {
    return "direct-redirect-unsafe";
  }

  return DEFAULT_REDIRECT_MODE;
}

function inferRedirectModeFromConfigs(configs) {
  if (String(configs?.["service-signing"]?.redirectServiceUrl || "").trim()) {
    return "service-signing";
  }

  if (
    String(configs?.["local-signing"]?.redirectBaseUrl || "").trim()
    && String(configs?.["local-signing"]?.redirectSigningSecret || "").trim()
  ) {
    return "local-signing";
  }

  if (String(configs?.["direct-redirect-unsafe"]?.redirectBaseUrl || "").trim()) {
    return "direct-redirect-unsafe";
  }

  return DEFAULT_REDIRECT_MODE;
}

function resolvePreferredRedirectMode(settings, fileSettings, redirectConfigs) {
  const storageMode = normalizeRedirectMode(settings?.redirectMode);
  const fileMode = normalizeRedirectMode(fileSettings?.redirectMode);
  const storageModeExplicit = settings?.redirectModeExplicit === true;

  if (storageModeExplicit && storageMode) {
    return storageMode;
  }

  if (hasAnyRedirectConfigSource(settings)) {
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

function assertHttpUrl(value, label = "Redirect base URL") {
  const url = new URL(value);
  if (!/^https?:$/i.test(url.protocol)) {
    throw new Error(`${label} must use http or https.`);
  }
}
