import type { DetectedStream, DomVideoInfo, Message, StreamKind } from "../lib/types";
import { isLikelyAdUrl, scoreStream } from "../lib/ad-filter";
import { parseM3U8 } from "../lib/m3u8-parser";
import { isYtDlpSite } from "../lib/ytdlp-sites";

const NATIVE_HOST = "com.videograbber.helper";
let nativePort: chrome.runtime.Port | null = null;

function ensureNativePort(): chrome.runtime.Port | null {
  if (nativePort) return nativePort;
  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST);
  } catch (e) {
    console.warn("[vg] connectNative failed:", e);
    return null;
  }
  nativePort.onMessage.addListener((msg: { type?: string; id?: string; [k: string]: unknown }) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "ready") {
      console.log("[vg] native host ready:", msg);
      return;
    }
    const id = msg.id as string | undefined;
    if (!id) return;
    if (msg.type === "formats") {
      const formats = Array.isArray(msg.formats) ? (msg.formats as Array<Record<string, unknown>>) : [];
      const out: Message = {
        type: "YTDLP_FORMATS",
        jobId: id,
        title: msg.title as string | undefined,
        duration: msg.duration as number | undefined,
        uploader: msg.uploader as string | undefined,
        thumbnail: msg.thumbnail as string | undefined,
        formats: formats.map((f) => ({
          format_id: String(f.format_id ?? ""),
          ext: f.ext as string | undefined,
          resolution: f.resolution as string | undefined,
          height: f.height as number | undefined,
          fps: f.fps as number | undefined,
          vcodec: f.vcodec as string | undefined,
          acodec: f.acodec as string | undefined,
          filesize: f.filesize as number | undefined,
          tbr: f.tbr as number | undefined,
          format_note: f.format_note as string | undefined,
        })),
      };
      chrome.runtime.sendMessage(out).catch(() => undefined);
    } else if (msg.type === "progress") {
      const out: Message = {
        type: "YTDLP_PROGRESS",
        jobId: id,
        pct: (msg.pct as number) ?? 0,
        speed: msg.speed as string | undefined,
        eta: msg.eta as string | undefined,
        line: msg.line as string | undefined,
      };
      chrome.runtime.sendMessage(out).catch(() => undefined);
    } else if (msg.type === "done") {
      const out: Message = {
        type: "YTDLP_DONE",
        jobId: id,
        ok: Boolean(msg.ok),
        file: msg.file as string | undefined,
        error: msg.error as string | undefined,
      };
      chrome.runtime.sendMessage(out).catch(() => undefined);
    } else if (msg.type === "folder_picked") {
      const out: Message = {
        type: "YTDLP_FOLDER_PICKED",
        jobId: id,
        ok: Boolean(msg.ok),
        path: msg.path as string | undefined,
        error: msg.error as string | undefined,
      };
      chrome.runtime.sendMessage(out).catch(() => undefined);
    }
  });
  nativePort.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    if (err) console.warn("[vg] native host disconnected:", err.message);
    nativePort = null;
  });
  return nativePort;
}

function sendNative(msg: Record<string, unknown>): boolean {
  const port = ensureNativePort();
  if (!port) return false;
  try {
    port.postMessage(msg);
    return true;
  } catch (e) {
    console.warn("[vg] postMessage to native failed:", e);
    nativePort = null;
    return false;
  }
}

void isYtDlpSite; // referenced in popup; keep import for tree-shake safety

const STREAMS_BY_TAB = new Map<number, Map<string, DetectedStream>>();
const DOM_BY_TAB = new Map<number, DomVideoInfo[]>();
const REQUEST_HEADERS: Map<string, Record<string, string>> = new Map();

const PLAYLIST_EXT = [".m3u8", ".mpd"];
const PROGRESSIVE_EXT = [".mp4", ".webm", ".m4v", ".mov"];
const SEGMENT_EXT = [".ts", ".m4s"];
const ALL_VIDEO_EXT = [...PLAYLIST_EXT, ...PROGRESSIVE_EXT, ...SEGMENT_EXT];

const VIDEO_MIME_RE = /^(video\/|application\/(vnd\.apple\.mpegurl|x-mpegurl|mpegurl|dash\+xml|f4m\+xml|x-mpegURL))|audio\/(mpegurl|x-mpegurl)/i;
const HLS_TEXT_HINT_RE = /(m3u8|hls|playlist|master|index|chunklist|manifest)/i;

function classify(url: string, mime?: string): StreamKind {
  const u = url.toLowerCase().split(/[?#]/)[0];
  if (u.endsWith(".m3u8") || (mime && /mpegurl/i.test(mime))) return "hls";
  if (u.endsWith(".mpd") || (mime && /dash/i.test(mime))) return "dash";
  if (PROGRESSIVE_EXT.some((e) => u.endsWith(e)) || (mime && /mp4|webm|x-matroska|quicktime/i.test(mime))) {
    return u.endsWith(".webm") || (mime && /webm/i.test(mime)) ? "webm" : "mp4";
  }
  // Heuristic: looks like an HLS-style path even without explicit extension
  if (HLS_TEXT_HINT_RE.test(u)) return "hls";
  // YouTube/googlevideo URLs carry mime in query params (e.g. mime=video%2Fmp4)
  try {
    const urlMime = new URL(url).searchParams.get("mime");
    if (urlMime) {
      if (/mpegurl/i.test(urlMime)) return "hls";
      if (/dash/i.test(urlMime)) return "dash";
      if (/mp4|webm|x-matroska|quicktime/i.test(urlMime))
        return /webm/i.test(urlMime) ? "webm" : "mp4";
      if (/^video\//i.test(urlMime)) return "mp4";
    }
  } catch { /* invalid URL */ }
  // Fallback: response MIME says video but URL has no recognizable extension
  if (mime && /^video\//i.test(mime)) return "mp4";
  return "unknown";
}

function shouldSniff(url: string, mime?: string): boolean {
  try {
    const p = new URL(url).protocol;
    if (p !== "http:" && p !== "https:") return false;
  } catch {
    return false;
  }
  const path = url.toLowerCase().split(/[?#]/)[0];
  if (ALL_VIDEO_EXT.some((ext) => path.endsWith(ext))) return true;
  if (mime) {
    if (VIDEO_MIME_RE.test(mime)) return true;
    if (/^application\/octet-stream/i.test(mime) && HLS_TEXT_HINT_RE.test(path)) return true;
    if (/^text\/plain/i.test(mime) && HLS_TEXT_HINT_RE.test(path)) return true;
  }
  // URL path hint without extension: e.g. .../hls/.../playlist or .../master?token=...
  if (HLS_TEXT_HINT_RE.test(path) && /\.(m3u8|ts|m4s)/.test(path)) return true;
  // Google CDN videoplayback URLs (carry mime= in query params)
  if (/googlevideo\.com\/videoplayback/.test(url)) return true;
  return false;
}

function streamKey(url: string): string {
  return url.split("#")[0];
}

function getTabMap(tabId: number): Map<string, DetectedStream> {
  let m = STREAMS_BY_TAB.get(tabId);
  if (!m) {
    m = new Map();
    STREAMS_BY_TAB.set(tabId, m);
  }
  return m;
}

function notifyPopup(tabId: number) {
  chrome.runtime.sendMessage({ type: "STREAMS_UPDATED", tabId } satisfies Message).catch(() => undefined);
  updateBadge(tabId);
}

function updateBadge(tabId: number) {
  const streams = STREAMS_BY_TAB.get(tabId);
  const visible = streams ? [...streams.values()].filter((s) => s.label !== "likely-ad").length : 0;
  const text = visible > 0 ? String(visible) : "";
  chrome.action.setBadgeText({ tabId, text }).catch(() => undefined);
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#dc2626" }).catch(() => undefined);
}

function recomputeScores(tabId: number) {
  const tabStreams = STREAMS_BY_TAB.get(tabId);
  if (!tabStreams) return;
  const dom = DOM_BY_TAB.get(tabId) ?? [];
  for (const s of tabStreams.values()) {
    const matched = dom.find((d) => d.currentSrc === s.url || d.src === s.url);
    const { score, label } = scoreStream(s, matched);
    s.score = score;
    s.label = label;
    if (matched) {
      s.fromDom = true;
      s.width = matched.videoWidth || s.width;
      s.height = matched.videoHeight || s.height;
      s.durationSec ??= matched.duration > 0 && isFinite(matched.duration) ? matched.duration : undefined;
      s.pageTitle = matched.pageTitle;
      s.pageUrl = matched.pageUrl;
    }
  }
}

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (!shouldSniff(details.url)) return;
    const headers: Record<string, string> = {};
    for (const h of details.requestHeaders ?? []) {
      if (h.name && h.value) headers[h.name] = h.value;
    }
    REQUEST_HEADERS.set(details.url, headers);
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders", "extraHeaders"],
);

const DEBUG_LOG = true;

chrome.webRequest.onResponseStarted.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const mime = details.responseHeaders?.find((h) => h.name.toLowerCase() === "content-type")?.value;
    const sniff = shouldSniff(details.url, mime);
    if (!sniff) {
      if (DEBUG_LOG && mime && /video|stream|mpegurl|dash|octet/i.test(mime)) {
        console.log("[vg] near-miss (skipped):", { url: details.url, mime, type: details.type });
      }
      return;
    }

    let kind = classify(details.url, mime);
    if (kind === "unknown" && mime && /^video\//i.test(mime)) {
      kind = "mp4";
    }
    if (kind === "unknown") {
      if (DEBUG_LOG) console.log("[vg] sniffed but unclassified:", { url: details.url, mime, type: details.type });
      return;
    }
    if (DEBUG_LOG) console.log("[vg] detected:", { kind, url: details.url, mime });

    const tabMap = getTabMap(details.tabId);
    const key = streamKey(details.url);
    const existing = tabMap.get(key);

    if (existing) {
      existing.lastSeen = Date.now();
      return;
    }

    const stream: DetectedStream = {
      id: crypto.randomUUID(),
      tabId: details.tabId,
      url: details.url,
      kind,
      mimeType: mime,
      fromDom: false,
      fromNetwork: true,
      score: 0,
      label: "unknown",
      requestHeaders: REQUEST_HEADERS.get(details.url),
      initiator: details.initiator,
      firstSeen: Date.now(),
      lastSeen: Date.now(),
    };

    if (isLikelyAdUrl(stream.url)) {
      stream.label = "likely-ad";
    }

    tabMap.set(key, stream);

    if (kind === "hls") {
      void enrichHls(stream).then(() => {
        recomputeScores(details.tabId);
        notifyPopup(details.tabId);
        if (DEBUG_LOG) {
          console.log("[vg] enriched HLS:", {
            url: stream.url,
            durationSec: stream.durationSec,
            durationFmt: stream.durationSec != null ? formatDur(stream.durationSec) : "?",
            qualities: stream.qualities?.map((q) => `${q.height ?? "?"}p@${Math.round(q.bandwidth / 1000)}kbps`) ?? [],
            score: stream.score,
            label: stream.label,
          });
        }
      });
    } else {
      recomputeScores(details.tabId);
      notifyPopup(details.tabId);
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"],
);

function formatDur(sec: number): string {
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${m}:${String(ss).padStart(2, "0")}`;
}

async function enrichHls(stream: DetectedStream): Promise<void> {
  const referer = stream.pageUrl ?? stream.initiator;
  const ruleId = referer ? await installRefererRule(stream.url, referer, true) : -1;
  try {
    const res = await fetch(stream.url, { credentials: "include" });
    if (!res.ok) {
      if (DEBUG_LOG) console.warn("[vg] enrich fetch failed:", stream.url, res.status);
      return;
    }
    const text = await res.text();
    if (DEBUG_LOG && !text.startsWith("#EXTM3U")) {
      console.warn("[vg] enrich got non-m3u8 content:", stream.url, "preview:", text.slice(0, 200));
      return;
    }
    const parsed = parseM3U8(text, stream.url);
    if (parsed.isMaster) {
      stream.qualities = parsed.qualities;
      const top = parsed.qualities[0];
      if (top) {
        try {
          const mres = await fetch(top.url, { credentials: "include" });
          if (mres.ok) {
            const mtext = await mres.text();
            if (mtext.startsWith("#EXTM3U")) {
              const mparsed = parseM3U8(mtext, top.url);
              if (!mparsed.isMaster) stream.durationSec = mparsed.durationSec;
            }
          }
        } catch {
          /* ignore */
        }
      }
    } else {
      stream.durationSec = parsed.durationSec;
    }
  } catch (e) {
    if (DEBUG_LOG) console.warn("[vg] enrich error:", stream.url, e);
  } finally {
    if (ruleId >= 0) removeRefererRule(ruleId);
  }
}

chrome.runtime.onMessage.addListener((msg: Message, sender, sendResponse) => {
  if (msg.type === "DOM_VIDEO_DETECTED") {
    const tabId = sender.tab?.id;
    if (tabId == null) return;
    const list = DOM_BY_TAB.get(tabId) ?? [];
    const existing = list.findIndex((d) => d.src === msg.payload.src || d.currentSrc === msg.payload.currentSrc);
    if (existing >= 0) list[existing] = msg.payload;
    else list.push(msg.payload);
    DOM_BY_TAB.set(tabId, list);

    const tabMap = getTabMap(tabId);
    if (msg.payload.currentSrc && /^(https?|blob):/.test(msg.payload.currentSrc)) {
      const key = streamKey(msg.payload.currentSrc);
      if (!tabMap.has(key) && !msg.payload.currentSrc.startsWith("blob:")) {
        tabMap.set(key, {
          id: crypto.randomUUID(),
          tabId,
          url: msg.payload.currentSrc,
          kind: classify(msg.payload.currentSrc),
          fromDom: true,
          fromNetwork: false,
          score: 0,
          label: "unknown",
          firstSeen: Date.now(),
          lastSeen: Date.now(),
          pageTitle: msg.payload.pageTitle,
          pageUrl: msg.payload.pageUrl,
        });
      }
    }

    recomputeScores(tabId);
    notifyPopup(tabId);
    return;
  }

  if (msg.type === "GET_STREAMS_FOR_TAB") {
    const map = STREAMS_BY_TAB.get(msg.tabId);
    const arr = map ? [...map.values()].sort((a, b) => b.score - a.score) : [];
    sendResponse(arr);
    return true;
  }

  if (msg.type === "DOWNLOAD_STREAM") {
    void handleDownload(msg.streamId, msg.qualityUrl, msg.filename);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "OFFSCREEN_BLOB_READY") {
    void chrome.downloads
      .download({ url: msg.blobUrl, filename: msg.filename, saveAs: true })
      .catch((e) => {
        console.warn("[vg] chrome.downloads.download failed:", e);
        pushDone(msg.streamId, false, String(e));
      });
    return;
  }

  if (msg.type === "DOWNLOAD_PROGRESS") {
    chrome.runtime.sendMessage(msg).catch(() => undefined);
    return;
  }

  if (msg.type === "DOWNLOAD_DONE") {
    const ruleId = PENDING_HLS_RULES.get(msg.streamId);
    if (ruleId != null) {
      removeRefererRule(ruleId);
      PENDING_HLS_RULES.delete(msg.streamId);
    }
    chrome.runtime.sendMessage(msg).catch(() => undefined);
    return;
  }

  if (msg.type === "YTDLP_PROBE") {
    const ok = sendNative({ type: "probe", id: msg.jobId, url: msg.url });
    if (!ok) {
      chrome.runtime
        .sendMessage({ type: "YTDLP_DONE", jobId: msg.jobId, ok: false, error: "Native host not available. Run Setup-TsWatcher.ps1." } satisfies Message)
        .catch(() => undefined);
    }
    return;
  }

  if (msg.type === "YTDLP_DOWNLOAD") {
    const ok = sendNative({ type: "download", id: msg.jobId, url: msg.url, format: msg.format, outDir: msg.outDir });
    if (!ok) {
      chrome.runtime
        .sendMessage({ type: "YTDLP_DONE", jobId: msg.jobId, ok: false, error: "Native host not available. Run Setup-TsWatcher.ps1." } satisfies Message)
        .catch(() => undefined);
    }
    return;
  }

  if (msg.type === "YTDLP_CANCEL") {
    sendNative({ type: "cancel", id: msg.jobId });
    return;
  }

  if (msg.type === "YTDLP_PICK_FOLDER") {
    const ok = sendNative({ type: "pick_folder", id: msg.jobId, initial: msg.initial });
    if (!ok) {
      chrome.runtime
        .sendMessage({ type: "YTDLP_FOLDER_PICKED", jobId: msg.jobId, ok: false, error: "Native host not available." } satisfies Message)
        .catch(() => undefined);
    }
    return;
  }
});

async function handleDownload(streamId: string, qualityUrl?: string, filename?: string) {
  const stream = findStream(streamId);
  if (!stream) return;

  // Pull tab title/url if not already attached (HLS streams often have no DOM match)
  if (!stream.pageTitle || !stream.pageUrl) {
    try {
      const tab = await chrome.tabs.get(stream.tabId);
      if (tab) {
        if (!stream.pageTitle && tab.title) stream.pageTitle = tab.title;
        if (!stream.pageUrl && tab.url) stream.pageUrl = tab.url;
      }
    } catch {
      /* ignore */
    }
  }

  const referer = stream.pageUrl ?? stream.requestHeaders?.["Referer"] ?? stream.requestHeaders?.["referer"];

  if (stream.kind === "mp4" || stream.kind === "webm" || stream.kind === "dash" || stream.kind === "unknown") {
    const ext = stream.kind === "webm" ? "webm" : "mp4";
    const fname = filename ?? buildFilename(stream, ext);
    const ruleId = await installRefererRule(stream.url, referer);
    try {
      const downloadId = await chrome.downloads.download({ url: stream.url, filename: fname, saveAs: true });
      pushProgress(streamId, "downloading", 10);
      await waitForDownload(downloadId);
      removeRefererRule(ruleId);
      pushProgress(streamId, "saved", 100);
      pushDone(streamId, true);
    } catch (e) {
      removeRefererRule(ruleId);
      pushDone(streamId, false, String(e));
    }
    return;
  }

  if (stream.kind === "hls") {
    const playlistUrl = qualityUrl ?? stream.url;
    const fname = filename ?? buildFilename(stream, "mp4");
    const ruleId = await installRefererRule(playlistUrl, referer, /* broad */ true);
    await ensureOffscreen();
    chrome.runtime.sendMessage({
      type: "OFFSCREEN_MERGE_HLS",
      streamId,
      playlistUrl,
      filename: fname,
      headers: stream.requestHeaders,
    } satisfies Message).catch(() => undefined);
    // Rule is removed when DOWNLOAD_DONE for this streamId arrives — see onMessage above.
    PENDING_HLS_RULES.set(streamId, ruleId);
    return;
  }

  pushDone(streamId, false, `Unsupported stream kind: ${stream.kind}`);
}

const PENDING_HLS_RULES = new Map<string, number>();

async function waitForDownload(downloadId: number): Promise<void> {
  return new Promise((resolve) => {
    const listener = (delta: chrome.downloads.DownloadDelta) => {
      if (delta.id !== downloadId) return;
      if (delta.state?.current === "complete" || delta.state?.current === "interrupted") {
        chrome.downloads.onChanged.removeListener(listener);
        resolve();
      }
    };
    chrome.downloads.onChanged.addListener(listener);
  });
}

let nextRuleId = 10000;
async function installRefererRule(url: string, referer?: string, broad = false): Promise<number> {
  if (!referer) return -1;
  const id = nextRuleId++;
  let urlFilter: string;
  try {
    const u = new URL(url);
    urlFilter = broad ? `||${u.hostname}/` : `${u.origin}${u.pathname}`;
  } catch {
    urlFilter = url;
  }
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      addRules: [
        {
          id,
          priority: 1,
          action: {
            type: "modifyHeaders" as chrome.declarativeNetRequest.RuleActionType,
            requestHeaders: [
              { header: "referer", operation: "set" as chrome.declarativeNetRequest.HeaderOperation, value: referer },
              { header: "origin", operation: "set" as chrome.declarativeNetRequest.HeaderOperation, value: new URL(referer).origin },
            ],
          },
          condition: {
            urlFilter,
            resourceTypes: [
              "media",
              "xmlhttprequest",
              "other",
              "sub_frame",
              "main_frame",
            ] as chrome.declarativeNetRequest.ResourceType[],
          },
        },
      ],
    });
  } catch (e) {
    console.warn("[vg] failed to install DNR rule", e);
    return -1;
  }
  return id;
}

function removeRefererRule(id: number) {
  if (id < 0) return;
  chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] }).catch(() => undefined);
}

function findStream(id: string): DetectedStream | undefined {
  for (const map of STREAMS_BY_TAB.values()) {
    for (const s of map.values()) if (s.id === id) return s;
  }
  return undefined;
}

function buildFilename(stream: DetectedStream, ext: string): string {
  const safe = (stream.pageTitle || "video").replace(/[^a-z0-9._-]+/gi, "_").slice(0, 80);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${safe}_${stamp}.${ext}`;
}

function pushProgress(streamId: string, phase: string, pct: number) {
  chrome.runtime
    .sendMessage({ type: "DOWNLOAD_PROGRESS", streamId, phase, pct } satisfies Message)
    .catch(() => undefined);
}

function pushDone(streamId: string, ok: boolean, error?: string) {
  chrome.runtime
    .sendMessage({ type: "DOWNLOAD_DONE", streamId, ok, error } satisfies Message)
    .catch(() => undefined);
}

let offscreenCreating: Promise<void> | null = null;
async function ensureOffscreen() {
  const url = chrome.runtime.getURL("src/offscreen/offscreen.html");
  const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType], documentUrls: [url] });
  if (existing.length > 0) return;
  if (offscreenCreating) {
    await offscreenCreating;
    return;
  }
  offscreenCreating = chrome.offscreen
    .createDocument({
      url,
      reasons: ["BLOBS" as chrome.offscreen.Reason, "WORKERS" as chrome.offscreen.Reason],
      justification: "Run ffmpeg.wasm to merge HLS segments into MP4",
    })
    .finally(() => {
      offscreenCreating = null;
    });
  await offscreenCreating;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  STREAMS_BY_TAB.delete(tabId);
  DOM_BY_TAB.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading" && info.url) {
    STREAMS_BY_TAB.delete(tabId);
    DOM_BY_TAB.delete(tabId);
    updateBadge(tabId);
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeBackgroundColor({ color: "#dc2626" }).catch(() => undefined);
});
