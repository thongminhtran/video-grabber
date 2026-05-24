import type { Message } from "../lib/types";
import { parseM3U8 } from "../lib/m3u8-parser";

function reportProgress(streamId: string, phase: string, pct: number) {
  chrome.runtime
    .sendMessage({ type: "DOWNLOAD_PROGRESS", streamId, phase, pct } satisfies Message)
    .catch(() => undefined);
}

function reportDone(streamId: string, ok: boolean, error?: string) {
  chrome.runtime
    .sendMessage({ type: "DOWNLOAD_DONE", streamId, ok, error } satisfies Message)
    .catch(() => undefined);
}

function filterHeaders(h: Record<string, string>): Record<string, string> {
  const skip = new Set([
    "host",
    "connection",
    "content-length",
    "cookie",
    "origin",
    "referer",
    "sec-ch-ua",
    "sec-ch-ua-mobile",
    "sec-ch-ua-platform",
    "user-agent",
    "accept-encoding",
  ]);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (!skip.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

function segmentKind(url: string): "ts" | "m4s" | "unknown" {
  const path = url.split("?")[0].toLowerCase();
  if (path.endsWith(".ts")) return "ts";
  if (path.endsWith(".m4s") || path.endsWith(".mp4")) return "m4s";
  return "unknown";
}

const CONCURRENCY = 8;

async function fetchBytes(url: string, headers?: HeadersInit): Promise<Uint8Array> {
  const res = await fetch(url, { credentials: "include", headers });
  if (!res.ok) throw new Error(`${url.slice(0, 80)}… → ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function fetchAllParallel(
  urls: string[],
  headers: HeadersInit | undefined,
  onProgress: (done: number, total: number) => void,
): Promise<Uint8Array[]> {
  const out = new Array<Uint8Array>(urls.length);
  let next = 0;
  let done = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(CONCURRENCY, urls.length); w++) {
    workers.push(
      (async () => {
        while (true) {
          const i = next++;
          if (i >= urls.length) return;
          out[i] = await fetchBytes(urls[i], headers);
          done++;
          onProgress(done, urls.length);
        }
      })(),
    );
  }
  await Promise.all(workers);
  return out;
}

async function mergeHls(streamId: string, playlistUrl: string, filenameHint: string, rawHeaders?: Record<string, string>) {
  try {
    reportProgress(streamId, "parsing-playlist", 1);
    const headers = rawHeaders ? new Headers(filterHeaders(rawHeaders)) : undefined;

    const masterRes = await fetch(playlistUrl, { credentials: "include", headers });
    if (!masterRes.ok) throw new Error(`Playlist ${masterRes.status}`);
    let parsed = parseM3U8(await masterRes.text(), playlistUrl);

    let mediaUrl = playlistUrl;
    if (parsed.isMaster) {
      const top = parsed.qualities[0];
      if (!top) throw new Error("Master playlist had no variants");
      mediaUrl = top.url;
      const mediaRes = await fetch(mediaUrl, { credentials: "include", headers });
      if (!mediaRes.ok) throw new Error(`Media playlist ${mediaRes.status}`);
      parsed = parseM3U8(await mediaRes.text(), mediaUrl);
    }
    if (parsed.isMaster) throw new Error("Could not resolve to a media playlist");

    const { segments, segDurations, initSegment } = parsed;
    if (segments.length === 0) throw new Error("Media playlist had no segments");

    const probeKind = segmentKind(segments[0]);
    const isFmp4 = !!initSegment || probeKind === "m4s";
    const outExt = isFmp4 ? "mp4" : "ts";
    const finalName = filenameHint.replace(/\.(mp4|ts)$/i, `.${outExt}`);

    let lastReport = 0;
    const onSegProgress = (done: number, total: number) => {
      const now = Date.now();
      if (now - lastReport > 250 || done === total) {
        lastReport = now;
        reportProgress(streamId, `downloading ${done}/${total}`, Math.round((done / total) * 95));
      }
    };

    const outputParts: Uint8Array[] = [];
    if (initSegment) outputParts.push(await fetchBytes(initSegment, headers));
    const segs = await fetchAllParallel(segments, headers, onSegProgress);
    outputParts.push(...segs);

    // segDurations is only used when remuxing (currently unused after rollback)
    void segDurations;

    reportProgress(streamId, "assembling", 97);

    const blob = new Blob(outputParts as BlobPart[], { type: isFmp4 ? "video/mp4" : "video/mp2t" });
    const url = URL.createObjectURL(blob);
    chrome.runtime
      .sendMessage({ type: "OFFSCREEN_BLOB_READY", streamId, blobUrl: url, filename: finalName } satisfies Message)
      .catch(() => undefined);
    setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000);

    reportProgress(streamId, "saved", 100);
    reportDone(streamId, true);
  } catch (e) {
    reportDone(streamId, false, e instanceof Error ? e.message : String(e));
  }
}

chrome.runtime.onMessage.addListener((msg: Message) => {
  if (msg.type === "OFFSCREEN_MERGE_HLS") {
    void mergeHls(msg.streamId, msg.playlistUrl, msg.filename, msg.headers);
  }
});

chrome.runtime.sendMessage({ type: "OFFSCREEN_READY" } satisfies Message).catch(() => undefined);
