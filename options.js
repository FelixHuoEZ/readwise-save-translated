const form = document.querySelector("#settings-form");
const tokenInput = document.querySelector("#token");
const titlePrefixInput = document.querySelector("#title-prefix");
const tagsInput = document.querySelector("#tags");
const captureModeInput = document.querySelector("#capture-mode");
const statusNode = document.querySelector("#status");
const configSourceNode = document.querySelector("#config-source");
const FILE_CONFIG_PATH = "config.local.json";

void loadSettings();

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const titlePrefix = titlePrefixInput.value || "[ZH] ";
  const defaultTags = tagsInput.value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);

  await chrome.storage.local.set({
    readwiseToken: tokenInput.value.trim(),
    titlePrefix,
    defaultTags,
    captureMode: captureModeInput.value === "text" ? "text" : "html"
  });

  statusNode.textContent = "Saved.";

  window.setTimeout(() => {
    statusNode.textContent = "";
  }, 2500);
});

async function loadSettings() {
  const [settings, fileSettings] = await Promise.all([
    chrome.storage.local.get([
      "readwiseToken",
      "titlePrefix",
      "defaultTags",
      "captureMode"
    ]),
    loadFileSettings()
  ]);

  const resolvedToken = settings.readwiseToken || fileSettings.readwiseToken || "";
  const resolvedTitlePrefix = settings.titlePrefix ?? fileSettings.titlePrefix ?? "[ZH] ";
  const resolvedTags = Array.isArray(settings.defaultTags)
    ? settings.defaultTags
    : Array.isArray(fileSettings.defaultTags)
      ? fileSettings.defaultTags
      : ["translated", "snapshot", "lang:zh", "chrome-extension"];
  const resolvedCaptureMode = settings.captureMode === "html" || settings.captureMode === "text"
    ? settings.captureMode
    : fileSettings.captureMode === "html" || fileSettings.captureMode === "text"
      ? fileSettings.captureMode
      : "html";

  tokenInput.value = resolvedToken;
  titlePrefixInput.value = resolvedTitlePrefix;
  tagsInput.value = resolvedTags.join(", ");
  captureModeInput.value = resolvedCaptureMode;

  if (
    fileSettings.readwiseToken ||
    fileSettings.titlePrefix ||
    Array.isArray(fileSettings.defaultTags) ||
    fileSettings.captureMode
  ) {
    configSourceNode.textContent = "File config detected. Reload the extension after editing config.local.json.";
  } else {
    configSourceNode.textContent = "";
  }
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
