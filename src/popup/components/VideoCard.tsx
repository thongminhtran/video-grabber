import { useMemo, useState } from "react";
import type { DetectedStream, Message } from "../../lib/types";
import { usePopupStore } from "../../lib/store";

interface Props {
  stream: DetectedStream;
  highlight?: boolean;
  dimmed?: boolean;
}

export function VideoCard({ stream, highlight, dimmed }: Props) {
  const download = usePopupStore((s) => s.downloads[stream.id]);
  const [selectedQualityUrl, setSelectedQualityUrl] = useState<string>(() => stream.qualities?.[0]?.url ?? stream.url);

  const sizeMb = useMemo(() => {
    if (!stream.durationSec) return null;
    const q = stream.qualities?.find((qq) => qq.url === selectedQualityUrl);
    const bandwidth = q?.bandwidth;
    if (!bandwidth) return null;
    return ((bandwidth * stream.durationSec) / 8 / 1024 / 1024).toFixed(1);
  }, [stream, selectedQualityUrl]);

  const onDownload = async () => {
    const msg: Message = { type: "DOWNLOAD_STREAM", streamId: stream.id, qualityUrl: stream.kind === "hls" ? selectedQualityUrl : undefined };
    await chrome.runtime.sendMessage(msg);
  };

  const onPreview = async () => {
    await chrome.tabs.create({ url: stream.url, active: true });
  };

  const onCopy = async () => {
    await navigator.clipboard.writeText(stream.url);
  };

  return (
    <div className={`vg-card${highlight ? " vg-card-main" : ""}${dimmed ? " vg-card-dim" : ""}`}>
      <div className="vg-card-top">
        <span className={`vg-kind vg-kind-${stream.kind}`}>{stream.kind.toUpperCase()}</span>
        <span className="vg-title" title={stream.pageTitle}>{stream.pageTitle || hostnameOf(stream.url)}</span>
      </div>

      <div className="vg-meta">
        {stream.durationSec ? <span>{formatDuration(stream.durationSec)}</span> : null}
        {stream.width && stream.height ? <span>{stream.width}×{stream.height}</span> : null}
        {sizeMb ? <span>~{sizeMb} MB</span> : null}
        <span className="vg-score">score {stream.score}</span>
      </div>

      <div className="vg-url" title={stream.url}>{truncate(stream.url, 90)}</div>

      {stream.kind === "hls" && stream.qualities && stream.qualities.length > 0 && (
        <div className="vg-quality">
          <label>Quality:</label>
          <select value={selectedQualityUrl} onChange={(e) => setSelectedQualityUrl(e.target.value)}>
            {stream.qualities.map((q) => (
              <option key={q.url} value={q.url}>
                {q.height ? `${q.height}p` : "audio"}{q.bandwidth ? ` · ${(q.bandwidth / 1000).toFixed(0)}kbps` : ""}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="vg-actions">
        <button className="vg-btn vg-btn-primary" onClick={onDownload} disabled={download && !download.done}>
          {download && !download.done ? `${download.phase} ${download.pct}%` : "Download"}
        </button>
        <button className="vg-btn" onClick={onPreview}>Preview</button>
        <button className="vg-btn" onClick={onCopy}>Copy URL</button>
      </div>

      {download?.error && <div className="vg-error">{download.error}</div>}
    </div>
  );
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

function formatDuration(sec: number): string {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  return `${m}:${String(ss).padStart(2, "0")}`;
}
