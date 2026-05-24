export type StreamKind = "mp4" | "webm" | "hls" | "dash" | "unknown";

export interface DetectedStream {
  id: string;
  tabId: number;
  url: string;
  kind: StreamKind;
  mimeType?: string;
  pageTitle?: string;
  pageUrl?: string;
  durationSec?: number;
  width?: number;
  height?: number;
  sizeBytesEstimate?: number;
  fromDom: boolean;
  fromNetwork: boolean;
  score: number;
  label: "main" | "likely-ad" | "unknown";
  qualities?: HlsQuality[];
  requestHeaders?: Record<string, string>;
  initiator?: string;
  firstSeen: number;
  lastSeen: number;
}

export interface HlsQuality {
  bandwidth: number;
  width?: number;
  height?: number;
  codecs?: string;
  url: string;
  isAudioOnly?: boolean;
}

export type Message =
  | { type: "DOM_VIDEO_DETECTED"; payload: DomVideoInfo }
  | { type: "GET_STREAMS_FOR_TAB"; tabId: number }
  | { type: "STREAMS_UPDATED"; tabId: number }
  | { type: "DOWNLOAD_STREAM"; streamId: string; qualityUrl?: string; filename?: string }
  | { type: "DOWNLOAD_PROGRESS"; streamId: string; phase: string; pct: number }
  | { type: "DOWNLOAD_DONE"; streamId: string; ok: boolean; error?: string }
  | { type: "OFFSCREEN_MERGE_HLS"; streamId: string; playlistUrl: string; filename: string; headers?: Record<string, string> }
  | { type: "OFFSCREEN_BLOB_READY"; streamId: string; blobUrl: string; filename: string }
  | { type: "OFFSCREEN_READY" }
  | { type: "YTDLP_PROBE"; jobId: string; url: string }
  | { type: "YTDLP_DOWNLOAD"; jobId: string; url: string; format?: string; outDir?: string }
  | { type: "YTDLP_CANCEL"; jobId: string }
  | { type: "YTDLP_PICK_FOLDER"; jobId: string; initial?: string }
  | { type: "YTDLP_FOLDER_PICKED"; jobId: string; ok: boolean; path?: string; error?: string }
  | { type: "YTDLP_FORMATS"; jobId: string; title?: string; duration?: number; uploader?: string; thumbnail?: string; formats: YtdlpFormat[] }
  | { type: "YTDLP_PROGRESS"; jobId: string; pct: number; speed?: string; eta?: string; line?: string }
  | { type: "YTDLP_DONE"; jobId: string; ok: boolean; file?: string; error?: string };

export interface YtdlpFormat {
  format_id: string;
  ext?: string;
  resolution?: string;
  height?: number;
  fps?: number;
  vcodec?: string;
  acodec?: string;
  filesize?: number;
  tbr?: number;
  format_note?: string;
}

export interface DomVideoInfo {
  src: string;
  currentSrc: string;
  isVisible: boolean;
  isPlaying: boolean;
  width: number;
  height: number;
  videoWidth: number;
  videoHeight: number;
  duration: number;
  parentClasses: string;
  pageTitle: string;
  pageUrl: string;
}
