const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright-core");
const { renderBannerHtml } = require("./template");

const ROOT_DIR = path.join(__dirname, "..");
const CONFIG_PATH = path.join(ROOT_DIR, "automation-config.json");
const OUTPUT_DIR = path.join(ROOT_DIR, "output");
const HTML_OUTPUT_PATH = path.join(OUTPUT_DIR, "image-banner.html");
const RESULT_PATH = path.join(OUTPUT_DIR, "image-result.json");

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function ensureOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
}

/* LOCAL FEATURE (disabled for now)
function resolveFinalOutputDir(config) {
  const configuredPath = typeof process.env.LOCAL_OUTPUT_DIR === "string" && process.env.LOCAL_OUTPUT_DIR.trim()
    ? process.env.LOCAL_OUTPUT_DIR.trim()
    : readString(config?.local_output_dir);

  const targetDir = configuredPath ? path.resolve(configuredPath) : OUTPUT_DIR;
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }
  return targetDir;
}

function saveLocalImageOutput(config, sourceFile) {
  const finalOutputDir = resolveFinalOutputDir(config);
  const extension = path.extname(sourceFile) || ".png";
  const localPath = path.join(finalOutputDir, `final-${Date.now()}${extension}`);
  fs.copyFileSync(sourceFile, localPath);
  return localPath;
}
*/

function readString(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function readUrlArray(value) {
  const rawItems = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/\r?\n|,/)
      : [];

  const seen = new Set();
  const urls = [];

  for (const item of rawItems) {
    if (typeof item !== "string") {
      continue;
    }

    const trimmed = item.trim();
    if (!trimmed || (!trimmed.startsWith("https://") && !trimmed.startsWith("http://"))) {
      continue;
    }

    if (seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    urls.push(trimmed);
  }

  return urls;
}

function normalizeResolution(value) {
  const raw = readString(value, "1080x1350");
  if (/^\d{3,5}x\d{3,5}$/.test(raw)) {
    return raw;
  }
  return "1080x1350";
}

function getAspectRatio(resolution) {
  const match = String(resolution).match(/^(\d+)x(\d+)$/);
  if (!match) {
    return "4:5";
  }

  const width = Number.parseInt(match[1], 10);
  const height = Number.parseInt(match[2], 10);
  if (width === height) {
    return "1:1";
  }
  if (width > height * 1.6) {
    return "16:9";
  }
  if (height > width * 1.6) {
    return "9:16";
  }
  return width > height ? "16:9" : "4:5";
}

function shouldSendWebhook() {
  return process.env.RUNNER_EXECUTION_MODE === "github" || process.env.RUNNER_EXECUTION_MODE === "local";
}

function resolveBrowserExecutable() {
  const explicit = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || process.env.CHROME_EXECUTABLE_PATH;
  if (explicit && fs.existsSync(explicit)) {
    return explicit;
  }

  try {
    const bundled = chromium.executablePath();
    if (bundled && fs.existsSync(bundled)) {
      return bundled;
    }
  } catch {}

  const candidates = [
    process.platform === "win32" ? path.join(process.env["ProgramFiles"] || "", "Google", "Chrome", "Application", "chrome.exe") : "",
    process.platform === "win32" ? path.join(process.env["ProgramFiles(x86)"] || "", "Google", "Chrome", "Application", "chrome.exe") : "",
    process.platform === "win32" ? path.join(process.env["ProgramFiles"] || "", "Microsoft", "Edge", "Application", "msedge.exe") : "",
    process.platform === "win32" ? path.join(process.env["ProgramFiles(x86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe") : "",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  if (process.platform !== "win32") {
    for (const command of ["google-chrome-stable", "google-chrome", "chromium-browser", "chromium"]) {
      try {
        const resolved = execFileSync("which", [command], { encoding: "utf8" }).trim();
        if (resolved && fs.existsSync(resolved)) {
          return resolved;
        }
      } catch {}
    }
  }

  throw new Error("Chromium/Chrome executable not found. Install Playwright Chromium or Google Chrome.");
}

async function uploadFile(filePath) {
  const fileName = path.basename(filePath);
  const fileBlob = new Blob([fs.readFileSync(filePath)]);
  const catboxUserhash = typeof process.env.CATBOX_USERHASH === "string" ? process.env.CATBOX_USERHASH.trim() : "";
  const targets = [
    {
      name: catboxUserhash ? "Catbox" : "Catbox Anonymous",
      url: "https://catbox.moe/user/api.php",
      buildForm() {
        const form = new FormData();
        form.append("reqtype", "fileupload");
        if (catboxUserhash) {
          form.append("userhash", catboxUserhash);
        }
        form.append("fileToUpload", fileBlob, fileName);
        return form;
      },
    },
    {
      name: "Litterbox",
      url: "https://litterbox.catbox.moe/resources/internals/api.php",
      buildForm() {
        const form = new FormData();
        form.append("reqtype", "fileupload");
        form.append("time", "72h");
        form.append("fileToUpload", fileBlob, fileName);
        return form;
      },
    },
    {
      name: "0x0.st",
      url: "https://0x0.st",
      buildForm() {
        const form = new FormData();
        form.append("file", fileBlob, fileName);
        form.append("expires", "24");
        return form;
      },
    },
  ];

  let lastError = "Image upload failed";
  const browserUA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

  for (const target of targets) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        console.log(`[IMAGE][UPLOAD] ${target.name} (attempt ${attempt}/2)...`);
        const response = await fetch(target.url, {
          method: "POST",
          body: target.buildForm(),
          headers: {
            "User-Agent": browserUA,
            "Accept": "*/*",
          },
        });
        const text = (await response.text()).trim();
        console.log(`[IMAGE][UPLOAD] ${target.name} HTTP ${response.status}: ${text.slice(0, 200)}`);
        if (response.ok && text.startsWith("https://")) {
          console.log(`[IMAGE][UPLOAD] ${target.name} OK: ${text}`);
          return text;
        }
        lastError = `${target.name} failed [HTTP ${response.status}]: ${text || response.statusText}`;
      } catch (error) {
        lastError = `${target.name} failed: ${error instanceof Error ? error.message : String(error)}`;
        console.error(`[IMAGE][UPLOAD] ${lastError}`);
      }
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
      }
    }
  }

  throw new Error(lastError);
}

async function sendWebhook(payload) {
  if (!shouldSendWebhook() || !process.env.WORKER_WEBHOOK_URL || !process.env.JOB_ID) {
    return;
  }

  try {
    await fetch(process.env.WORKER_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        job_id: Number(process.env.JOB_ID),
        automation_id: Number(process.env.AUTOMATION_ID || "0") || null,
        ...payload,
      }),
    });
  } catch (error) {
    console.error("[IMAGE][WEBHOOK] Failed:", error instanceof Error ? error.message : String(error));
  }
}

async function renderCloudflareImage(config) {
  const resolution = normalizeResolution(config.output_resolution || config.image_render_spec?.resolution);
  const [width, height] = resolution.split("x").map((value) => Number.parseInt(value, 10) || 1024);
  const baseUrl = String(process.env.WORKER_WEBHOOK_URL || "").replace(/\/api\/webhook\/github\/?$/, "");
  const jobId = Number(process.env.JOB_ID || 0);
  const token = String(process.env.RUNTIME_CONFIG_TOKEN || "");
  if (!baseUrl || !jobId || !token) throw new Error("Cloudflare AI image generation requires WORKER_WEBHOOK_URL, JOB_ID, and RUNTIME_CONFIG_TOKEN");

  const prompt = readString(
    config.cloudflare_image_prompt || config.ai_prompt || config.banner_prompt || config.banner_title || config.automation_name,
    "A polished social media visual matching the automation brief"
  );
  const response = await fetch(`${baseUrl}/api/image-generation/scene`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "WaqasAIStudioImageRunner/1.0" },
    body: JSON.stringify({
      job_id: jobId,
      token,
      prompt: prompt.slice(0, 4000),
      image_model: config.cloudflare_image_model,
      width,
      height,
    }),
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Cloudflare AI image generation failed (${response.status}): ${errorText.slice(0, 400)}`);
  }

  const contentType = response.headers.get("content-type") || "image/png";
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 1000) throw new Error(`Cloudflare AI image response is unexpectedly small (${bytes.length} bytes)`);
  const outputExtension = contentType.includes("jpeg") ? "jpg" : contentType.includes("webp") ? "webp" : "png";
  const outputFile = path.join(OUTPUT_DIR, `generated-cloudflare-ai.${outputExtension}`);
  fs.writeFileSync(outputFile, bytes);
  return { outputFile, aspectRatio: getAspectRatio(resolution), resolution };
}

async function renderImage(config) {
  const resolution = normalizeResolution(config.output_resolution || config.image_render_spec?.resolution);
  const [width, height] = resolution.split("x").map((value) => Number.parseInt(value, 10) || 1080);
  const format = readString(config.output_format, "png").toLowerCase();
  const outputExtension = format === "jpeg" || format === "jpg" ? "jpg" : (format === "webp" ? "webp" : "png");
  const outputFile = path.join(OUTPUT_DIR, `generated-banner.${outputExtension}`);
  const browserExecutable = resolveBrowserExecutable();
  const html = renderBannerHtml({
    ...config,
    output_resolution: resolution,
  });

  fs.writeFileSync(HTML_OUTPUT_PATH, html, "utf8");

  const browser = await chromium.launch({
    executablePath: browserExecutable,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.setContent(html, { waitUntil: "networkidle" });
    await page.screenshot({
      path: outputFile,
      type: outputExtension === "jpg" ? "jpeg" : outputExtension,
      quality: outputExtension === "jpg" ? 92 : undefined,
    });
  } finally {
    await browser.close();
  }

  return {
    outputFile,
    aspectRatio: getAspectRatio(resolution),
    resolution,
  };
}

async function main() {
  ensureOutputDir();
  const config = loadConfig();
  const imageMode = readString(config.image_mode || config.image_source, "html_banner");
  const sourceImageUrls = readUrlArray(config.source_image_urls || config.source_image_url || config.image_url);
  const sourceImageUrl = sourceImageUrls[0] || readString(config.source_image_url || config.image_url);

  if (imageMode === "source_url" && sourceImageUrl) {
    const result = {
      media_kind: "image",
      media_url: sourceImageUrl,
      media_urls: sourceImageUrls.length > 0 ? sourceImageUrls : [sourceImageUrl],
      aspect_ratio: getAspectRatio(normalizeResolution(config.output_resolution)),
      resolution: normalizeResolution(config.output_resolution),
      mode: "source_url",
    };
    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), "utf8");
    await sendWebhook({
      status: "success",
      video_url: sourceImageUrl,
      output_data: result,
    });
    return;
  }

  if (imageMode === "cloudflare_ai") {
    const rendered = await renderCloudflareImage(config);
    const mediaUrl = await uploadFile(rendered.outputFile);
    const result = {
      media_kind: "image",
      media_url: mediaUrl,
      media_urls: [mediaUrl],
      aspect_ratio: rendered.aspectRatio,
      resolution: rendered.resolution,
      mode: "cloudflare_ai",
      cloudflare_image_model: config.cloudflare_image_model,
    };
    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), "utf8");
    await sendWebhook({ status: "success", video_url: mediaUrl, output_data: result });
    return;
  }

  const rendered = await renderImage(config);
  
  /* LOCAL FEATURE (disabled for now)
  if (config.skip_upload === true) {
    const localPath = saveLocalImageOutput(config, rendered.outputFile);
    console.log(`[IMAGE][LOCAL] Skipping upload as per config. Image saved at: ${localPath}`);
    const localResult = { media_kind: "image", media_url: localPath, mode: "local_save" };
    fs.writeFileSync(RESULT_PATH, JSON.stringify(localResult, null, 2), "utf8");
    await sendWebhook({ status: "success", video_url: null, output_data: localResult });
    return;
  }
  */

  const mediaUrl = await uploadFile(rendered.outputFile);
  const result = {
    media_kind: "image",
    media_url: mediaUrl,
    media_urls: [mediaUrl],
    aspect_ratio: rendered.aspectRatio,
    resolution: rendered.resolution,
    mode: "html_banner",
  };

  fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), "utf8");

  await sendWebhook({
    status: "success",
    video_url: mediaUrl,
    output_data: result,
  });
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("[IMAGE] Failed:", message);
  try {
    fs.writeFileSync(
      RESULT_PATH,
      JSON.stringify({ error: message }, null, 2),
      "utf8"
    );
  } catch {}

  await sendWebhook({
    status: "failed",
    error_message: message,
    output_data: { error: message },
  });
  process.exit(1);
});
