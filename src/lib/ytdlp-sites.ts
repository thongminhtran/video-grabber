// Heuristic URL match for sites where yt-dlp is the right tool (extension's
// HLS/MP4 sniffing won't capture these because of signed URLs, MediaSource, etc.)
const PATTERNS: RegExp[] = [
  /(^|\.)youtube\.com$/i,
  /(^|\.)youtu\.be$/i,
  /(^|\.)youtube-nocookie\.com$/i,
  /(^|\.)twitter\.com$/i,
  /(^|\.)x\.com$/i,
  /(^|\.)vimeo\.com$/i,
  /(^|\.)twitch\.tv$/i,
  /(^|\.)tiktok\.com$/i,
  /(^|\.)instagram\.com$/i,
  /(^|\.)facebook\.com$/i,
  /(^|\.)reddit\.com$/i,
  /(^|\.)bilibili\.com$/i,
  /(^|\.)soundcloud\.com$/i,
  /(^|\.)dailymotion\.com$/i,
  /(^|\.)bandcamp\.com$/i,
];

export function isYtDlpSite(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return PATTERNS.some((re) => re.test(host));
  } catch {
    return false;
  }
}

export function siteLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "site";
  }
}
