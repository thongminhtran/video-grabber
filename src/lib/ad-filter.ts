import type { DetectedStream, DomVideoInfo } from "./types";

const AD_DOMAINS = [
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
  "googletagservices.com",
  "adservice.google.com",
  "adsystem.com",
  "adnxs.com",
  "scorecardresearch.com",
  "moatads.com",
  "imasdk.googleapis.com",
  "pubmatic.com",
  "serving-sys.com",
  "2mdn.net",
  "innovid.com",
  "spotxchange.com",
  "rubiconproject.com",
  "openx.net",
  "criteo.com",
  "criteo.net",
  "taboola.com",
  "outbrain.com",
  "trafficjunky.net",
  "trafficjunky.com",
  "exoclick.com",
  "exosrv.com",
  "playhubconnect.com",
  "hubtraffic.com",
  "trafficstars.com",
  "tsyndicate.net",
  "juicyads.com",
  "tsyndicate.com",
  "ero-advertising.com",
  "popads.net",
  "popcash.net",
  "propellerads.com",
  "adsterra.com",
  "media.net",
];

const AD_PATH_HINTS = ["/ads/", "/ad/", "/preroll", "/midroll", "/postroll", "/vast", "/vpaid", "ima/", "/banner"];

export function isLikelyAdUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (AD_DOMAINS.some((d) => host === d || host.endsWith("." + d))) return true;
    const lower = u.pathname.toLowerCase();
    if (AD_PATH_HINTS.some((h) => lower.includes(h))) return true;
  } catch {
    /* ignore */
  }
  return false;
}

export function scoreStream(s: DetectedStream, dom?: DomVideoInfo): { score: number; label: DetectedStream["label"] } {
  let score = 0;

  if (isLikelyAdUrl(s.url)) score -= 80;

  if (s.kind === "hls" || s.kind === "dash") score += 15;
  if (s.kind === "mp4" || s.kind === "webm") score += 10;

  if (s.qualities && s.qualities.length >= 2) score += 25;
  if (s.qualities && s.qualities.length === 1) score += 15;
  const topQ = s.qualities?.[0];
  if (topQ?.height && topQ.height >= 720) score += 10;
  if (topQ?.height && topQ.height >= 1080) score += 10;
  if (s.kind === "hls" && s.durationSec && s.durationSec > 90) score += 15;

  if (s.durationSec != null) {
    if (s.durationSec < 30) score -= 40;
    else if (s.durationSec < 90) score -= 10;
    else if (s.durationSec >= 90 && s.durationSec < 600) score += 10;
    else score += 25;
  }

  if (s.fromDom) score += 30;

  if (dom?.isPlaying) score += 25;
  if (dom?.isVisible) score += 15;

  const parentClasses = (dom?.parentClasses ?? "").toLowerCase();
  if (/(ad|advert|banner|promo|sponsor|preroll)/.test(parentClasses)) score -= 30;

  if (dom && dom.videoWidth >= 1280) score += 10;

  let label: DetectedStream["label"];
  if (score >= 30) label = "main";
  else if (score <= -20) label = "likely-ad";
  else label = "unknown";

  return { score, label };
}
