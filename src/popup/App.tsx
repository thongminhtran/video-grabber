import { useEffect, useMemo, useState } from "react";
import { usePopupStore } from "../lib/store";
import type { DetectedStream, Message } from "../lib/types";
import { VideoCard } from "./components/VideoCard";
import { YtdlpCard } from "./components/YtdlpCard";
import { isYtDlpSite, siteLabel } from "../lib/ytdlp-sites";

export function App() {
  const tabId = usePopupStore((s) => s.tabId);
  const streams = usePopupStore((s) => s.streams);
  const setTabId = usePopupStore((s) => s.setTabId);
  const setStreams = usePopupStore((s) => s.setStreams);
  const setDownload = usePopupStore((s) => s.setDownload);
  const [showAds, setShowAds] = useState(false);
  const [tabUrl, setTabUrl] = useState<string>("");
  const [tabTitle, setTabTitle] = useState<string>("");

  useEffect(() => {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return;
      setTabId(tab.id);
      setTabUrl(tab.url ?? "");
      setTabTitle(tab.title ?? "");
      const res = await chrome.runtime.sendMessage({ type: "GET_STREAMS_FOR_TAB", tabId: tab.id } satisfies Message);
      if (Array.isArray(res)) setStreams(res as DetectedStream[]);
    })();
  }, [setTabId, setStreams]);

  const showYtdlp = useMemo(() => tabUrl && isYtDlpSite(tabUrl), [tabUrl]);

  useEffect(() => {
    function handler(msg: Message) {
      if (msg.type === "STREAMS_UPDATED" && msg.tabId === tabId) {
        void chrome.runtime.sendMessage({ type: "GET_STREAMS_FOR_TAB", tabId } satisfies Message).then((res) => {
          if (Array.isArray(res)) setStreams(res as DetectedStream[]);
        });
      } else if (msg.type === "DOWNLOAD_PROGRESS") {
        setDownload({ streamId: msg.streamId, phase: msg.phase, pct: msg.pct, done: false });
      } else if (msg.type === "DOWNLOAD_DONE") {
        setDownload({ streamId: msg.streamId, phase: msg.ok ? "done" : "error", pct: msg.ok ? 100 : 0, done: true, error: msg.error });
      }
    }
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, [tabId, setStreams, setDownload]);

  const { main, others, ads } = useMemo(() => {
    const main: DetectedStream[] = [];
    const others: DetectedStream[] = [];
    const ads: DetectedStream[] = [];
    for (const s of streams) {
      if (s.label === "main") main.push(s);
      else if (s.label === "likely-ad") ads.push(s);
      else others.push(s);
    }
    return { main, others, ads };
  }, [streams]);

  const visibleCount = main.length + others.length;

  return (
    <div className="vg-root">
      <header className="vg-header">
        <div className="vg-logo">Video Grabber</div>
        <div className="vg-count">
          {visibleCount} detected{ads.length > 0 ? ` · ${ads.length} filtered` : ""}
        </div>
      </header>

      {showYtdlp && (
        <section className="vg-section">
          <h2 className="vg-section-title">YouTube / yt-dlp supported site</h2>
          <YtdlpCard url={tabUrl} pageTitle={tabTitle} host={siteLabel(tabUrl)} />
        </section>
      )}

      {visibleCount === 0 && ads.length === 0 && !showYtdlp && (
        <div className="vg-empty">
          <p>No streams detected on this tab yet.</p>
          <p className="vg-empty-sub">Start playing a video, then reopen this popup.</p>
        </div>
      )}

      {main.length > 0 && (
        <section className="vg-section">
          <h2 className="vg-section-title">Main video</h2>
          {main.map((s) => <VideoCard key={s.id} stream={s} highlight />)}
        </section>
      )}

      {others.length > 0 && (
        <section className="vg-section">
          <h2 className="vg-section-title">Other detected</h2>
          {others.map((s) => <VideoCard key={s.id} stream={s} />)}
        </section>
      )}

      {ads.length > 0 && (
        <section className="vg-section">
          <button className="vg-toggle" onClick={() => setShowAds((v) => !v)}>
            {showAds ? "Hide" : "Show"} likely ads ({ads.length})
          </button>
          {showAds && ads.map((s) => <VideoCard key={s.id} stream={s} dimmed />)}
        </section>
      )}

      <footer className="vg-footer">
        <span>For personal use with content you have the right to download.</span>
      </footer>
    </div>
  );
}
