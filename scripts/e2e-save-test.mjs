import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const extensionDir = path.resolve(process.cwd());
const extensionId = "dkpfnjefefaponcimmnjmllahplmlffa";
const configPath = path.join(extensionDir, "config.local.json");
const config = JSON.parse(await fs.readFile(configPath, "utf8"));

if (!config.readwiseToken || config.readwiseToken === "PASTE_YOUR_READWISE_TOKEN_HERE") {
  console.error("Missing Readwise token in config.local.json");
  process.exit(1);
}

const { chromium } = await import("playwright");
const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "readwise-save-translated-"));

const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: [
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`
  ]
});

let savedDocumentId = null;

try {
  const articlePage = await context.newPage();
  await articlePage.goto("https://example.com/", { waitUntil: "domcontentloaded" });
  await articlePage.evaluate(() => {
    document.title = "示例页面（翻译测试）";
    document.body.innerHTML = `
      <main style="font-family: sans-serif; max-width: 48rem; margin: 3rem auto; line-height: 1.7;">
        <h1>示例页面</h1>
        <p>这是一次翻译后快照保存测试。</p>
        <p>如果 Readwise 里能看到这一段中文，说明扩展抓到的是浏览器当前 DOM，而不是原始英文页面。</p>
      </main>
    `;
  });

  const controlPage = await context.newPage();
  await controlPage.goto(`chrome-extension://${extensionId}/details.html`, {
    waitUntil: "domcontentloaded"
  });

  const result = await controlPage.evaluate(async () => {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const articleTab = tabs.find((tab) => tab.url?.startsWith("https://example.com/"));

    if (!articleTab?.id) {
      throw new Error("Unable to find the example.com tab.");
    }

    return await chrome.runtime.sendMessage({
      type: "save-active-tab",
      tabId: articleTab.id
    });
  });

  console.log(JSON.stringify(result, null, 2));

  if (!result?.ok || !result?.result?.readerDocumentId) {
    console.error("Extension save did not return a Reader document id.");
    process.exit(1);
  }

  savedDocumentId = result.result.readerDocumentId;
  console.error(`SAVED_DOCUMENT_ID=${savedDocumentId}`);
} finally {
  await context.close();
  await fs.rm(userDataDir, { recursive: true, force: true });
}
