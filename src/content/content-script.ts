import type { DomVideoInfo, Message } from "../lib/types";

function describeVideo(v: HTMLVideoElement): DomVideoInfo {
  const rect = v.getBoundingClientRect();
  const isVisible = rect.width > 50 && rect.height > 50 && rect.bottom > 0 && rect.right > 0;
  const parent = v.parentElement;
  let parentClasses = parent?.className ?? "";
  if (typeof parentClasses !== "string") parentClasses = "";
  return {
    src: v.src ?? "",
    currentSrc: v.currentSrc ?? "",
    isVisible,
    isPlaying: !v.paused && !v.ended && v.readyState >= 2,
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    videoWidth: v.videoWidth,
    videoHeight: v.videoHeight,
    duration: v.duration,
    parentClasses: String(parentClasses),
    pageTitle: document.title,
    pageUrl: location.href,
  };
}

function report(v: HTMLVideoElement) {
  const info = describeVideo(v);
  const msg: Message = { type: "DOM_VIDEO_DETECTED", payload: info };
  chrome.runtime.sendMessage(msg).catch(() => undefined);
}

const tracked = new WeakSet<HTMLVideoElement>();

function attach(v: HTMLVideoElement) {
  if (tracked.has(v)) return;
  tracked.add(v);

  const events = ["loadedmetadata", "play", "playing", "pause", "ended", "ratechange", "loadeddata"];
  for (const ev of events) v.addEventListener(ev, () => report(v));
  report(v);
}

function scan(root: ParentNode | Document) {
  const vids = root.querySelectorAll?.("video");
  vids?.forEach((v) => attach(v as HTMLVideoElement));
}

scan(document);

const obs = new MutationObserver((mutations) => {
  for (const m of mutations) {
    m.addedNodes.forEach((n) => {
      if (n instanceof HTMLVideoElement) attach(n);
      else if (n instanceof Element) scan(n);
    });
  }
});

obs.observe(document.documentElement, { childList: true, subtree: true });

setInterval(() => {
  document.querySelectorAll("video").forEach((v) => report(v as HTMLVideoElement));
}, 5000);
