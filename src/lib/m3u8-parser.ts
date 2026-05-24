import type { HlsQuality } from "./types";

export interface ParsedMaster {
  isMaster: true;
  qualities: HlsQuality[];
}

export interface ParsedMedia {
  isMaster: false;
  durationSec: number;
  segments: string[];
  segDurations: number[];
  initSegment?: string;
}

export function parseM3U8(text: string, baseUrl: string): ParsedMaster | ParsedMedia {
  const lines = text.split(/\r?\n/);
  const isMaster = lines.some((l) => l.startsWith("#EXT-X-STREAM-INF"));

  if (isMaster) {
    const qualities: HlsQuality[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("#EXT-X-STREAM-INF")) {
        const attrs = parseAttrList(line.slice(line.indexOf(":") + 1));
        const next = (lines[i + 1] || "").trim();
        if (!next || next.startsWith("#")) continue;
        const resolution = attrs.RESOLUTION;
        const [w, h] = resolution ? resolution.split("x").map((n) => parseInt(n, 10)) : [undefined, undefined];
        qualities.push({
          bandwidth: parseInt(attrs.BANDWIDTH ?? "0", 10),
          width: w,
          height: h,
          codecs: attrs.CODECS,
          url: resolveUrl(next, baseUrl),
        });
      }
    }
    qualities.sort((a, b) => (b.height ?? b.bandwidth) - (a.height ?? a.bandwidth));
    return { isMaster: true, qualities };
  }

  let duration = 0;
  const segments: string[] = [];
  const segDurations: number[] = [];
  let initSegment: string | undefined;
  let pendingDur = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXTINF")) {
      const m = line.match(/#EXTINF:([\d.]+)/);
      if (m) pendingDur = parseFloat(m[1]);
    } else if (line.startsWith("#EXT-X-MAP")) {
      const attrs = parseAttrList(line.slice(line.indexOf(":") + 1));
      if (attrs.URI) initSegment = resolveUrl(attrs.URI, baseUrl);
    } else if (!line.startsWith("#")) {
      segments.push(resolveUrl(line, baseUrl));
      segDurations.push(pendingDur);
      duration += pendingDur;
      pendingDur = 0;
    }
  }

  return { isMaster: false, durationSec: duration, segments, segDurations, initSegment };
}

function parseAttrList(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    out[m[1]] = m[3] ?? m[2];
  }
  return out;
}

function resolveUrl(ref: string, base: string): string {
  try {
    return new URL(ref, base).toString();
  } catch {
    return ref;
  }
}
