/**
 * Perstudio API Plugin for OpenClaw — v3.2.0
 *
 * Modal serverless GPU: generate_sync / generate / run_workflow trigger
 * auto-scaling containers. Cold starts handled by comfyui_client retry.
 * Containers auto-scale to zero after 5 min idle — no manual stop needed.
 */

import { readFile, writeFile, appendFile, mkdir, access, realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { tmpdir, homedir } from "node:os";

// ── Helpers ──────────────────────────────────────────────

function text(s) {
  return { content: [{ type: "text", text: String(s) }] };
}

function errorResult(msg) {
  return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}

// Allowed directories for file operations (path traversal prevention)
const ALLOWED_FILE_DIRS = [
  join(tmpdir(), "perstudio"),
  join(homedir(), ".openclaw", "workspace"),
  join(homedir(), "Downloads"),
  join(homedir(), "Pictures"),
  join(homedir(), "Desktop"),
  tmpdir(),
];

async function validateFilePath(filePath) {
  const real = await realpath(filePath);
  const allowed = ALLOWED_FILE_DIRS.some((dir) => real.startsWith(dir + "/") || real === dir);
  if (!allowed) {
    throw new Error(
      "File path not allowed. Files must be in tmp/perstudio, workspace, Downloads, Pictures, or Desktop."
    );
  }
  return real;
}

function sanitizeError(detail) {
  const msg = typeof detail === "object" ? JSON.stringify(detail) : String(detail);
  if (/content policy|nsfw/i.test(msg))
    return "This request was blocked by our content policy. Please try a different prompt.";
  if (/temporarily blocked|rate.?limit/i.test(msg))
    return "Too many requests. Please wait a moment before trying again.";
  if (/insufficient token/i.test(msg))
    return "Insufficient token balance. Please purchase more tokens to continue.";
  if (/timed? ?out/i.test(msg))
    return "Generation timed out. Please try again.";
  return "Generation failed. Please try a different prompt or try again later.";
}
async function mediaResult(summaryText, filePath, logger) {
  const isVideo = filePath.endsWith('.mp4');
  const blocks = [];

  if (isVideo) {
    blocks.push({ type: "text", text: summaryText + "\n\nFILE:" + filePath });
  } else {
    try {
      // Resize large images to stay under 5MB base64 limit (~3.7MB raw)
      const { execFileSync } = await import("node:child_process");
      const tmpJpg = filePath.replace(/\.[^.]+$/, "_thumb.jpg");
      try {
        execFileSync(
          "convert",
          [filePath, "-resize", "2048x2048>", "-quality", "85", tmpJpg],
          { timeout: 10000 }
        );
      } catch {
        // ImageMagick not available, try ffmpeg
        execFileSync(
          "ffmpeg",
          ["-y", "-i", filePath, "-vf", "scale='min(2048,iw)':'min(2048,ih)':force_original_aspect_ratio=decrease", tmpJpg],
          { timeout: 10000 }
        );
      }
      const imgData = await readFile(tmpJpg);
      blocks.push({ type: "image", data: imgData.toString("base64"), mimeType: "image/jpeg" });
    } catch (e) {
      if (logger) logger.error("perstudio-api: failed to create thumbnail for content block: " + e.message);
      // Fall back to just the MEDIA path without image block
    }
    blocks.push({ type: "text", text: summaryText + "\n\nMEDIA:" + filePath });
  }

  return { content: blocks };
}


async function httpJson(url, options = {}) {
  const { method = "GET", headers = {}, body, timeoutMs } = options;
  const opts = { method, headers: { ...headers } };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  if (timeoutMs) {
    opts.signal = AbortSignal.timeout(timeoutMs);
  }
  const res = await fetch(url, opts);
  const resText = await res.text();
  let data;
  try {
    data = JSON.parse(resText);
  } catch {
    data = resText;
  }
  return { status: res.status, ok: res.ok, data };
}

// ── Constants ────────────────────────────────────────────

const BASE_URL = process.env.PERSTUDIO_BASE_URL || "https://api.perstudio.ai";
const SYNC_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// ── Pod lifecycle (Modal: simplified) ────────────────────

async function ensurePodRunning(hdrs, logger) {
  // With Modal, we just check if the endpoint is configured and reachable.
  // Cold starts (502/503) are handled by comfyui_client's retry logic.
  // No need for a poll loop — the first real request will wake the container.
  const status = await httpJson(`${BASE_URL}/pod/status`, { headers: hdrs });
  if (status.ok && status.data?.status === "running") {
    return { ready: true, alreadyRunning: true };
  }
  if (status.ok && (status.data?.status === "cold" || status.data?.status === "starting")) {
    // Container is cold but will auto-start on first real request
    logger.info("perstudio-api: Modal container is cold, will auto-start on request");
    return { ready: true, alreadyRunning: false };
  }
  if (status.ok && status.data?.proxy_url) {
    // Has a URL configured — assume it'll work (retry handles cold starts)
    return { ready: true, alreadyRunning: false };
  }
  // No URL configured at all
  throw new Error("ComfyUI endpoint not configured (COMFYUI_BASE_URL not set)");
}

// ── Asset download ───────────────────────────────────────

const MIME_EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
};

const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024; // 500 MB

async function downloadAsset(assetId, jobId, hdrs) {
  const res = await fetch(
    `${BASE_URL}/assets/${encodeURIComponent(assetId)}`,
    { headers: { "X-API-Key": hdrs["X-API-Key"] } }
  );
  if (!res.ok) throw new Error(`Asset download failed: HTTP ${res.status}`);

  // Check Content-Length header before downloading full body
  const clHeader = res.headers.get("content-length");
  if (clHeader && parseInt(clHeader, 10) > MAX_DOWNLOAD_BYTES) {
    throw new Error(`Asset too large: ${clHeader} bytes exceeds ${MAX_DOWNLOAD_BYTES / (1024*1024)}MB limit`);
  }

  const contentType = res.headers.get("content-type") || "image/png";
  const ext = MIME_EXT[contentType] || "png";
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_DOWNLOAD_BYTES) {
    throw new Error(`Asset too large: ${buffer.length} bytes exceeds ${MAX_DOWNLOAD_BYTES / (1024*1024)}MB limit`);
  }

  const outDir = join(tmpdir(), "perstudio");
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, `${jobId}.${ext}`);
  await writeFile(outPath, buffer);
  return outPath;
}

// ── Memory persistence ───────────────────────────────────

const GALLERY_DIR = join(homedir(), ".openclaw", "workspace", "memory");
const GALLERY_PATH = join(GALLERY_DIR, "perstudio-gallery.md");
const GALLERY_HEADER = "## Perstudio Gallery\n\nGenerated images and videos from perstudio workflows.\n\n";

async function persistToMemory({ intent, workflowName, jobId, assetId, filePath, logger }) {
  try {
    await mkdir(GALLERY_DIR, { recursive: true });

    try {
      await access(GALLERY_PATH);
    } catch {
      await writeFile(GALLERY_PATH, GALLERY_HEADER);
    }

    const now = new Date();
    const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const desc = intent ? `"${intent}"` : "(direct workflow run)";
    const wf = workflowName ? ` → ${workflowName}` : "";
    const entry = `- ${ts} — ${desc}${wf}, job ${jobId}, asset ${assetId}, saved ${filePath}\n`;
    await appendFile(GALLERY_PATH, entry);
    logger.info(`perstudio-api: gallery entry written for job ${jobId}`);
  } catch (err) {
    logger.error(`perstudio-api: persistToMemory failed: ${err.message}`);
  }
}

// ── Catbox image hosting ─────────────────────────────────

const CATBOX_URL = "https://catbox.moe/user/api.php";

async function uploadToCatbox(filePath) {
  const fileData = await readFile(filePath);
  const fileName = basename(filePath);
  const formData = new FormData();
  formData.append("reqtype", "fileupload");
  formData.append("fileToUpload", new Blob([fileData]), fileName);
  const res = await fetch(CATBOX_URL, { method: "POST", body: formData });
  const url = await res.text();
  if (!res.ok || !url.startsWith("http")) {
    throw new Error(`Catbox upload failed: ${res.status} ${url}`);
  }
  return url.trim();
}

// ── Moltbook posting ─────────────────────────────────────

const MOLTBOOK_BASE = "https://www.moltbook.com/api/v1";

async function postToMoltbook({ title, content, submolt, url, logger }) {
  const apiKey = process.env.MOLTBOOK_API_KEY;
  if (!apiKey) throw new Error("MOLTBOOK_API_KEY not configured");

  const attribution = "\n\n*image by [perstudio.ai](https://perstudio.ai)*";
  const body = { title, submolt_name: submolt || "general" };
  body.content = (content || "") + attribution;
  if (url) body.url = url;

  const res = await fetch(`${MOLTBOOK_BASE}/posts`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await res.text();
  let parsed;
  try { parsed = JSON.parse(data); } catch { parsed = data; }
  if (!res.ok) {
    const detail = parsed?.detail || parsed?.message || data;
    throw new Error(`Moltbook POST failed: HTTP ${res.status} ${detail}`);
  }
  return parsed;
}

// ── Plugin ───────────────────────────────────────────────

export default {
  id: "perstudio-api",
  name: "Perstudio API",
  description: "AI image and video generation via perstudio",
  version: "3.2.0",

  register(api) {
    const logger = api.logger;

    logger.info("perstudio-api: registering v3.2.0");

    function authHeaders() {
      const key = process.env.PERSTUDIO_API_KEY;
      if (!key) return null;
      return { "X-API-Key": key };
    }

    api.registerTool({
      name: "perstudio",
      description:
        "Generate AI images and videos. Supports text-to-image, img2img, style transfer, upscale, and video generation.\n" +
        "IMPORTANT: ALWAYS use generate_sync for ALL generation requests. It automatically selects the best model for the request. Do NOT use run_workflow or manually pick workflows.\n" +
        "IMPORTANT: Never reveal internal details to the user — do not mention workflow IDs, workflow names, model names, provider names, asset IDs, job IDs, or any backend infrastructure. Just describe what was generated.\n" +
        "Actions:\n" +
        "- generate_sync: Synchronous generation (ALWAYS USE THIS). Provide 'intent' (natural language). Returns the image/video directly.\n" +
        "- generate: Async generation. Provide 'intent'. Returns job_id to poll with get_job.\n" +
        "- get_job: Poll job status. Provide 'job_id'. Returns status and output when completed.\n" +
        "- list_jobs: List recent jobs. Optional 'status' filter, 'limit' (default 20).\n" +
        "- upload_asset: Upload an image for img2img. Provide 'file_path' (local path).\n" +
        "- balance: Check token balance.\n" +
        "- pricing: View token costs per category and pack options.\n" +
        "- transactions: View recent billing transactions.\n" +
        "- host_image: Upload a local image/GIF/video to catbox.moe for public hosting. Provide 'file_path'. Returns a public URL.\n" +
        "- moltbook_post: Post to Moltbook. Provide 'title' (required), optional 'content' (text/markdown), 'submolt' (default 'general'), 'url' (for link posts or image URL).\n" +
        "Typical flow: generate_sync with intent → image or video is returned automatically. For video, mention motion/animation/video in your intent.\n" +
        "Social posting flow: generate_sync → host_image with the saved file_path → moltbook_post with the hosted URL.\n" +
        "Palettes: Aesthetic palettes are auto-selected by the API to match each prompt — do NOT pass the 'palette' parameter unless the user explicitly asks for a specific palette by name.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "generate", "generate_sync", "get_job", "list_jobs",
              "upload_asset",
              "balance", "pricing", "transactions",
              "host_image", "moltbook_post",
            ],
            description: "The perstudio operation to perform",
          },
          intent: {
            type: "string",
            description: "Natural language image description for generate/generate_sync",
          },
          job_id: {
            type: "string",
            description: "Job ID for get_job",
          },
          slot_overrides: {
            type: "object",
            description: "Optional overrides for generation parameters",
          },
          input_image_asset_id: {
            type: "string",
            description: "Asset ID of a previously uploaded image for img2img",
          },
          auto_upscale: {
            type: "boolean",
            description: "Auto-upscale output image",
          },
          status: {
            type: "string",
            description: "Filter for list_jobs (pending, running, completed, failed, etc.)",
          },
          limit: {
            type: "integer",
            description: "Limit for list_workflows/list_jobs/transactions",
          },
          file_path: {
            type: "string",
            description: "Local file path for upload_asset or host_image",
          },
          title: {
            type: "string",
            description: "Post title for moltbook_post (required)",
          },
          content: {
            type: "string",
            description: "Post body text/markdown for moltbook_post",
          },
          submolt: {
            type: "string",
            description: "Moltbook community to post in (default: 'general')",
          },
          url: {
            type: "string",
            description: "URL for moltbook_post link posts (e.g. hosted image URL)",
          },
          palette: {
            type: "string",
            description: "Explicit palette override — only use when the user asks for a specific palette by name. The API auto-selects palettes otherwise.",
          },
        },
        required: ["action"],
        additionalProperties: false,
      },

      async execute(_id, args) {
        const start = Date.now();
        const { action } = args;

        const hdrs = authHeaders();
        if (!hdrs && !["capabilities", "onboard", "pricing", "host_image", "moltbook_post"].includes(action)) {
          return errorResult("PERSTUDIO_API_KEY not configured");
        }

        try {
          let res;

          switch (action) {
            // ── Generation (async) ───────────────────────
            case "generate": {
              if (!args.intent) return errorResult("'intent' is required for generate");

              await ensurePodRunning(hdrs, logger);

              const body = { intent: args.intent };
              if (args.input_image_asset_id) body.input_image_asset_id = args.input_image_asset_id;
              if (args.slot_overrides) body.slot_overrides = args.slot_overrides;
              if (args.workflow_id) body.workflow_id = args.workflow_id;
              if (args.auto_upscale !== undefined) body.auto_upscale = args.auto_upscale;
              if (args.palette) body.palette = args.palette;
              res = await httpJson(`${BASE_URL}/generate`, {
                method: "POST", headers: hdrs, body,
              });
              break;
            }

            // ── Generation (sync + auto download) ────────
            case "generate_sync": {
              if (!args.intent) return errorResult("'intent' is required for generate_sync");

              await ensurePodRunning(hdrs, logger);

              const body = { intent: args.intent };
              if (args.input_image_asset_id) body.input_image_asset_id = args.input_image_asset_id;
              if (args.slot_overrides) body.slot_overrides = args.slot_overrides;
              if (args.workflow_id) body.workflow_id = args.workflow_id;
              if (args.auto_upscale !== undefined) body.auto_upscale = args.auto_upscale;
              if (args.palette) body.palette = args.palette;
              res = await httpJson(`${BASE_URL}/agent/generate`, {
                method: "POST", headers: hdrs, body,
                timeoutMs: SYNC_TIMEOUT_MS,
              });

              if (!res.ok) break;

              // Download first output asset
              const genData = res.data;
              const assets = genData?.output_assets || genData?.outputs;
              const firstAsset = Array.isArray(assets) && assets[0];
              const assetId = typeof firstAsset === "string" ? firstAsset : (firstAsset?.asset_id || firstAsset?.id);
              const jobId = genData?.job_id || genData?.id || "unknown";

              if (assetId) {
                try {
                  const filePath = await downloadAsset(assetId, jobId, hdrs);
                  const latency = Date.now() - start;
                  logger.info(`perstudio-api: generate_sync completed, asset downloaded latency=${latency}ms`);
                  persistToMemory({
                    intent: args.intent,
                    workflowName: genData?.workflow_name || genData?.workflow,
                    jobId,
                    assetId,
                    filePath,
                    logger,
                  }).catch((e) => logger.error(`perstudio-api: persistToMemory error: ${e.message}`));
                  return await mediaResult("Generation complete.", filePath, logger);
                } catch (dlErr) {
                  logger.error(`perstudio-api: asset download failed: ${dlErr.message}`);
                  return text("Generation completed but the file could not be retrieved. Please try again.");
                }
              }

              const latency = Date.now() - start;
              logger.info(`perstudio-api: generate_sync completed (no asset) latency=${latency}ms`);
              return text("Generation completed but produced no output.");
            }

            // ── Jobs ─────────────────────────────────────
            case "get_job": {
              if (!args.job_id) return errorResult("'job_id' is required for get_job");
              res = await httpJson(
                `${BASE_URL}/jobs/${encodeURIComponent(args.job_id)}`,
                { headers: hdrs }
              );
              if (res.ok && typeof res.data === "object") {
                const { workflow_id, workflow_name, error, ...safe } = res.data;
                if (safe.status === "failed") safe.error = sanitizeError(error || "");
                res = { ...res, data: safe };
              }
              break;
            }

            case "list_jobs": {
              const params = new URLSearchParams();
              if (args.status) params.set("status", args.status);
              if (args.limit) params.set("limit", String(args.limit));
              const qs = params.toString();
              res = await httpJson(`${BASE_URL}/jobs${qs ? "?" + qs : ""}`, {
                headers: hdrs,
              });
              if (res.ok && Array.isArray(res.data)) {
                res = { ...res, data: res.data.map(j => {
                  const { workflow_id, workflow_name, error, ...safe } = j;
                  if (safe.status === "failed") safe.error = sanitizeError(error || "");
                  return safe;
                })};
              }
              break;
            }

            // ── Workflows & Discovery ────────────────────
            case "list_workflows": {
              const params = new URLSearchParams();
              if (args.category) params.set("category", args.category);
              if (args.query) params.set("q", args.query);
              if (args.limit) params.set("limit", String(args.limit));
              const qs = params.toString();
              res = await httpJson(`${BASE_URL}/workflows${qs ? "?" + qs : ""}`, {
                headers: hdrs || {},
              });
              break;
            }

            case "capabilities": {
              res = await httpJson(`${BASE_URL}/capabilities`, {
                headers: hdrs || {},
              });
              break;
            }

            case "onboard": {
              res = await httpJson(`${BASE_URL}/agent/onboard`, {
                headers: hdrs || {},
              });
              break;
            }

            // ── Workflow run (disabled — use generate_sync) ──
            case "run_workflow": {
              return errorResult("run_workflow is disabled. Use generate_sync with an intent instead — it automatically picks the best workflow.");
            }

            // ── Asset Upload ─────────────────────────────
            case "upload_asset": {
              if (!args.file_path) return errorResult("'file_path' is required for upload_asset");
              let fileData;
              try {
                await validateFilePath(args.file_path);
                fileData = await readFile(args.file_path);
              } catch (e) {
                return errorResult(`Cannot read file: ${e.message}`);
              }
              const uploadFileName = basename(args.file_path);
              const formData = new FormData();
              formData.append("file", new Blob([fileData]), uploadFileName);
              const uploadRes = await fetch(`${BASE_URL}/assets`, {
                method: "POST",
                headers: { "X-API-Key": hdrs["X-API-Key"] },
                body: formData,
              });
              const uploadText = await uploadRes.text();
              let uploadData;
              try { uploadData = JSON.parse(uploadText); } catch { uploadData = uploadText; }
              res = { status: uploadRes.status, ok: uploadRes.ok, data: uploadData };
              break;
            }

            // ── Pod Lifecycle (Modal: mostly no-ops) ─────
            case "pod_status": {
              res = await httpJson(`${BASE_URL}/pod/status`, { headers: hdrs });
              break;
            }

            case "pod_start": {
              // Modal auto-starts — this just sends a warm-up ping
              res = await httpJson(`${BASE_URL}/pod/start`, {
                method: "POST", headers: hdrs,
              });
              break;
            }

            case "pod_stop": {
              // Modal auto-scales to zero — this is a no-op
              res = await httpJson(`${BASE_URL}/pod/stop`, {
                method: "POST", headers: hdrs,
              });
              break;
            }

            // ── Billing ──────────────────────────────────
            case "balance": {
              res = await httpJson(`${BASE_URL}/billing/balance`, { headers: hdrs });
              break;
            }

            case "pricing": {
              res = await httpJson(`${BASE_URL}/billing/pricing`, { headers: hdrs || {} });
              break;
            }

            case "transactions": {
              const params = new URLSearchParams();
              if (args.limit) params.set("limit", String(args.limit));
              const qs = params.toString();
              res = await httpJson(
                `${BASE_URL}/billing/transactions${qs ? "?" + qs : ""}`,
                { headers: hdrs }
              );
              break;
            }

            // ── Image Hosting (catbox.moe) ─────────────
            case "host_image": {
              if (!args.file_path) return errorResult("'file_path' is required for host_image");
              try { await validateFilePath(args.file_path); } catch (e) {
                return errorResult(e.message);
              }
              const publicUrl = await uploadToCatbox(args.file_path);
              const latency = Date.now() - start;
              logger.info(`perstudio-api: host_image uploaded to ${publicUrl} latency=${latency}ms`);
              return text(JSON.stringify({ url: publicUrl, file_path: args.file_path }, null, 2));
            }

            // ── Moltbook Posting (disabled) ──────────────
            case "moltbook_post": {
              return errorResult("Moltbook posting is temporarily disabled by the owner.");
            }

            default:
              return errorResult(`Unknown action: ${action}`);
          }

          const latency = Date.now() - start;
          logger.info(
            `perstudio-api: action=${action}` +
            `${args.job_id ? ` job_id=${args.job_id}` : ""}` +
            `${args.workflow_id ? ` workflow_id=${args.workflow_id}` : ""}` +
            ` status=${res.status} latency=${latency}ms`
          );

          if (!res.ok) {
            const detail =
              typeof res.data === "object" && res.data?.detail
                ? res.data.detail
                : typeof res.data === "string"
                  ? res.data
                  : JSON.stringify(res.data);
            if (["generate", "generate_sync", "get_job"].includes(action)) {
              return errorResult(sanitizeError(detail));
            }
            return errorResult(`HTTP ${res.status}: ${detail}`);
          }

          return text(typeof res.data === "string" ? res.data : JSON.stringify(res.data, null, 2));
        } catch (err) {
          const latency = Date.now() - start;
          logger.error(`perstudio-api: action=${action} error=${err.message} latency=${latency}ms`);
          if (["generate", "generate_sync", "get_job"].includes(action)) {
            return errorResult(sanitizeError(err.message));
          }
          if (err.name === "TimeoutError") {
            return errorResult(`Request timed out after ${Math.round(latency / 1000)}s`);
          }
          return errorResult(`Request failed: ${err.message}`);
        }
      },
    });

    logger.info("perstudio-api: tool registered (perstudio)");
  },
};
