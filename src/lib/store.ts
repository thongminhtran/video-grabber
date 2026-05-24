import { create } from "zustand";
import type { DetectedStream } from "./types";

export interface DownloadState {
  streamId: string;
  phase: string;
  pct: number;
  done: boolean;
  error?: string;
}

interface PopupState {
  tabId: number | null;
  streams: DetectedStream[];
  downloads: Record<string, DownloadState>;
  setTabId: (id: number) => void;
  setStreams: (s: DetectedStream[]) => void;
  setDownload: (d: DownloadState) => void;
}

export const usePopupStore = create<PopupState>((set) => ({
  tabId: null,
  streams: [],
  downloads: {},
  setTabId: (id) => set({ tabId: id }),
  setStreams: (s) => set({ streams: s }),
  setDownload: (d) =>
    set((state) => ({
      downloads: { ...state.downloads, [d.streamId]: d },
    })),
}));
