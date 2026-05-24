import { useEffect, useMemo, useState } from "react";
import type { Message, YtdlpFormat } from "../../lib/types";

interface Props {
  url: string;
  pageTitle: string;
  host: string;
}

type Status = "idle" | "probing" | "ready" | "downloading" | "done" | "error";

const STORAGE_KEY = "ytdlp_out_dir";

export function YtdlpCard({ url, pageTitle, host }: Props) {
  const [status, setStatus] = useState<Status>("idle");
  const [title, setTitle] = useState<string | undefined>(pageTitle);
  const [duration, setDuration] = useState<number | undefined>();
  const [thumbnail, setThumbnail] = useState<string | undefined>();
  const [formats, setFormats] = useState<YtdlpFormat[]>([]);
  const [selectedFmtId, setSelectedFmtId] = useState<string>("bv*+ba/b");
  const [pct, setPct] = useState(0);
  const [speed, setSpeed] = useState<string | undefined>();
  const [eta, setEta] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [outputFile, setOutputFile] = useState<string | undefined>();
  const [jobId, setJobId] = useState<string>("");
  const [outDir, setOutDir] = useState<string>("");
  const [folderJobId, setFolderJobId] = useState<string>("");

  useEffect(() => {
    chrome.storage.local.get(STORAGE_KEY).then((res) => {
      const saved = res[STORAGE_KEY];
      if (typeof saved === "string") setOutDir(saved);
    });
  }, []);

  // Listen for native host messages
  useEffect(() => {
    const handler = (msg: Message) => {
      if (msg.type === "YTDLP_FORMATS" && msg.jobId === jobId) {
        if (msg.title) setTitle(msg.title);
        if (msg.duration) setDuration(msg.duration);
        if (msg.thumbnail) setThumbnail(msg.thumbnail);
        setFormats(msg.formats);
        setStatus("ready");
      } else if (msg.type === "YTDLP_PROGRESS" && msg.jobId === jobId) {
        setPct(msg.pct);
        setSpeed(msg.speed);
        setEta(msg.eta);
        setStatus("downloading");
      } else if (msg.type === "YTDLP_DONE" && msg.jobId === jobId) {
        if (msg.ok) {
          setStatus("done");
          setPct(100);
          setOutputFile(msg.file);
        } else {
          setStatus("error");
          setError(msg.error || "yt-dlp failed");
        }
      } else if (msg.type === "YTDLP_FOLDER_PICKED" && msg.jobId === folderJobId) {
        if (msg.ok && msg.path) {
          setOutDir(msg.path);
          chrome.storage.local.set({ [STORAGE_KEY]: msg.path });
        }
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, [jobId, folderJobId]);

  const pickFolder = async () => {
    const id = crypto.randomUUID();
    setFolderJobId(id);
    const msg: Message = { type: "YTDLP_PICK_FOLDER", jobId: id, initial: outDir || undefined };
    await chrome.runtime.sendMessage(msg);
  };

  const probe = async () => {
    const id = crypto.randomUUID();
    setJobId(id);
    setStatus("probing");
    setError(undefined);
    setFormats([]);
    const msg: Message = { type: "YTDLP_PROBE", jobId: id, url };
    await chrome.runtime.sendMessage(msg);
  };

  const download = async () => {
    const id = crypto.randomUUID();
    setJobId(id);
    setStatus("downloading");
    setPct(0);
    setError(undefined);
    const msg: Message = { type: "YTDLP_DOWNLOAD", jobId: id, url, format: selectedFmtId, outDir: outDir || undefined };
    await chrome.runtime.sendMessage(msg);
  };

  const cancel = async () => {
    const msg: Message = { type: "YTDLP_CANCEL", jobId };
    await chrome.runtime.sendMessage(msg);
    setStatus("idle");
  };

  const qualityOptions = useMemo(() => {
    const opts: Array<{ id: string; label: string }> = [
      { id: "bv*+ba/b", label: "Best (video+audio merged)" },
      { id: "bv[height<=1080]+ba/b[height<=1080]", label: "≤1080p" },
      { id: "bv[height<=720]+ba/b[height<=720]", label: "≤720p" },
      { id: "ba/b", label: "Audio only" },
    ];
    const seen = new Set<string>();
    for (const f of formats) {
      if (!f.format_id || seen.has(f.format_id)) continue;
      seen.add(f.format_id);

      const hasVideo = f.vcodec && f.vcodec !== "none";
      const hasAudio = f.acodec && f.acodec !== "none";

      const parts: string[] = [];
      if (f.resolution) parts.push(f.resolution);
      else if (f.height) parts.push(`${f.height}p`);
      if (f.fps) parts.push(`${f.fps}fps`);
      if (f.ext) parts.push(f.ext);
      if (hasVideo) parts.push(f.vcodec!);
      if (f.filesize) parts.push(`${(f.filesize / 1024 / 1024).toFixed(0)}MB`);
      if (!hasAudio && hasVideo) parts.push("(video-only, audio auto-paired)");
      if (!hasVideo && hasAudio) parts.push("audio");

      // Build format string: if video-only, pair with best audio so yt-dlp merges
      const fmtId = (!hasAudio && hasVideo) ? `${f.format_id}+ba/b` : f.format_id;
      opts.push({ id: fmtId, label: `[${f.format_id}] ${parts.join(" · ")}` });
    }
    return opts;
  }, [formats]);

  return (
    <div className="vg-card vg-card-main vg-card-ytdlp">
      <div className="vg-card-top">
        <span className="vg-kind vg-kind-ytdlp">YT-DLP</span>
        <span className="vg-title" title={title}>{title || host}</span>
      </div>

      <div className="vg-meta">
        <span>{host}</span>
        {duration ? <span>{formatDur(duration)}</span> : null}
        {status === "downloading" && speed ? <span>{speed}</span> : null}
        {status === "downloading" && eta ? <span>ETA {eta}</span> : null}
      </div>

      {thumbnail && status !== "idle" ? (
        <img src={thumbnail} alt="" style={{ width: "100%", borderRadius: 4, marginBottom: 8, maxHeight: 120, objectFit: "cover" }} />
      ) : null}

      {status !== "idle" && (
        <div className="vg-quality">
          <label>Quality:</label>
          <select value={selectedFmtId} onChange={(e) => setSelectedFmtId(e.target.value)} disabled={status === "downloading"}>
            {qualityOptions.map((o) => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>
        </div>
      )}

      {status === "downloading" && (
        <div className="vg-progress">
          <div className="vg-progress-bar" style={{ width: `${pct}%` }} />
          <span className="vg-progress-text">{pct.toFixed(1)}%</span>
        </div>
      )}

      <div className="vg-folder">
        <span className="vg-folder-label">Save to:</span>
        <span className="vg-folder-path" title={outDir || "Default: ~/Downloads/Private"}>{outDir || "~/Downloads/Private (default)"}</span>
        <button className="vg-folder-btn" onClick={pickFolder} disabled={status === "downloading"}>Change…</button>
      </div>

      <div className="vg-actions">
        {status === "idle" && (
          <button className="vg-btn vg-btn-primary" onClick={probe}>List qualities (yt-dlp)</button>
        )}
        {status === "probing" && (
          <button className="vg-btn vg-btn-primary" disabled>Probing…</button>
        )}
        {(status === "ready" || status === "done" || status === "error") && (
          <button className="vg-btn vg-btn-primary" onClick={download}>
            {status === "done" ? "Download again" : "Download"}
          </button>
        )}
        {status === "downloading" && (
          <button className="vg-btn" onClick={cancel}>Cancel</button>
        )}
      </div>

      {status === "done" && outputFile && (
        <div className="vg-success" title={outputFile}>Saved: {basename(outputFile)}</div>
      )}
      {error && <div className="vg-error">{error}</div>}
    </div>
  );
}

function formatDur(sec: number): string {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  return `${m}:${String(ss).padStart(2, "0")}`;
}

function basename(p: string): string {
  const m = p.match(/[\\/]([^\\/]+)$/);
  return m ? m[1] : p;
}
