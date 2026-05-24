"""
Native messaging host for the Video Grabber extension.
Bridges chrome.runtime.connectNative <-> yt-dlp subprocess.

Protocol (Chrome native messaging):
  Inbound  (browser -> us):  4-byte LE length + JSON body
  Outbound (us -> browser):  same

Messages from extension:
  { id: str, type: "probe",    url: str }
  { id: str, type: "download", url: str, format: str|None, outDir: str|None }
  { id: str, type: "cancel" }

Messages we emit:
  { id, type: "formats",  formats: [...] }
  { id, type: "progress", pct: float, line: str, speed: str|None, eta: str|None }
  { id, type: "started",  pid: int }
  { id, type: "done",     ok: bool, file: str|None, error: str|None }
  { type: "ready", version: str, ytdlp: str }
"""

from __future__ import annotations
import json
import os
import re
import struct
import subprocess
import sys
import threading
import shutil
import traceback
from pathlib import Path

VERSION = "0.1.0"
DEFAULT_OUTDIR = Path.home() / "Downloads" / "Private"
LOG_FILE = DEFAULT_OUTDIR / ".native-host.log"

# Windows: silence subprocess console windows
_CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0


def _log(text: str) -> None:
    try:
        LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            from datetime import datetime
            f.write(f"[{datetime.now().isoformat(timespec='seconds')}] {text}\n")
    except Exception:
        pass


_stdout_lock = threading.Lock()
_jobs_lock = threading.Lock()
_jobs: dict[str, subprocess.Popen] = {}


def _read_message() -> dict | None:
    raw_len = sys.stdin.buffer.read(4)
    if not raw_len:
        _log("stdin EOF (0 bytes)")
        return None
    if len(raw_len) < 4:
        _log(f"short header: {len(raw_len)} bytes")
        return None
    length = struct.unpack("<I", raw_len)[0]
    if length == 0:
        _log("zero-length frame")
        return None
    body = sys.stdin.buffer.read(length)
    if len(body) < length:
        _log(f"short body: {len(body)}/{length}")
        return None
    try:
        msg = json.loads(body.decode("utf-8"))
        _log(f"recv: {msg.get('type','?')} id={msg.get('id','?')}")
        return msg
    except Exception as e:
        _log(f"json decode failed: {e}")
        return None


def _send(msg: dict) -> None:
    data = json.dumps(msg, ensure_ascii=False).encode("utf-8")
    with _stdout_lock:
        sys.stdout.buffer.write(struct.pack("<I", len(data)))
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
    _log(f"send: {msg.get('type','?')} id={msg.get('id','?')} bytes={len(data)}")


def _ytdlp_path() -> str | None:
    found = shutil.which("yt-dlp") or shutil.which("yt-dlp.exe")
    if found:
        return found
    candidates = [
        Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "WinGet" / "Links" / "yt-dlp.exe",
        Path(os.environ.get("ProgramFiles", "")) / "yt-dlp" / "yt-dlp.exe",
    ]
    for c in candidates:
        if c and c.exists():
            return str(c)
    return None


def _ffmpeg_path() -> str | None:
    found = shutil.which("ffmpeg") or shutil.which("ffmpeg.exe")
    if found:
        return found
    candidates = [
        Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "WinGet" / "Links" / "ffmpeg.exe",
        Path(os.environ.get("ProgramFiles", "")) / "ffmpeg" / "bin" / "ffmpeg.exe",
    ]
    for c in candidates:
        if c and c.exists():
            return str(c)
    globs = [
        Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "WinGet" / "Packages",
    ]
    for base in globs:
        if not base.exists():
            continue
        for pkg in base.glob("Gyan.FFmpeg*/ffmpeg-*/bin/ffmpeg.exe"):
            return str(pkg)
        for pkg in base.glob("yt-dlp.FFmpeg*/**/ffmpeg.exe"):
            return str(pkg)
    return None


_PROGRESS_RE = re.compile(
    r"\[download\]\s+(?P<pct>[\d.]+)%(?:\s+of\s+~?\s*(?P<size>[\d.]+\s*\w+))?"
    r"(?:\s+at\s+(?P<speed>[^\s]+))?(?:\s+ETA\s+(?P<eta>[^\s]+))?",
)
_DEST_RE = re.compile(r"\[download\]\s+Destination:\s+(.+)$")
_MERGE_RE = re.compile(r"\[Merger\]\s+Merging formats into\s+\"(.+)\"$")
_FILE_RE = re.compile(r"\[(?:download|VideoConvertor|ExtractAudio)\]\s+(?:Already downloaded\s+)?(.+)")


def _handle_probe(req: dict) -> None:
    req_id = req.get("id", "")
    url = req.get("url", "")
    ytdlp = _ytdlp_path()
    if not ytdlp:
        _log("probe: yt-dlp not found")
        _send({"id": req_id, "type": "done", "ok": False, "error": "yt-dlp not found"})
        return
    _log(f"probe: launching yt-dlp -J on {url[:80]}")
    try:
        proc = subprocess.run(
            [ytdlp, "-J", "--no-warnings", "--no-playlist", url],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=60,
            creationflags=_CREATE_NO_WINDOW,
        )
        _log(f"probe: yt-dlp exit={proc.returncode}, stdout={len(proc.stdout)}B, stderr={len(proc.stderr)}B")
        if proc.returncode != 0:
            _send({"id": req_id, "type": "done", "ok": False, "error": proc.stderr.decode("utf-8", "replace")[:2000]})
            return
        info = json.loads(proc.stdout.decode("utf-8", "replace"))
        formats = []
        for f in info.get("formats", []) or []:
            formats.append({
                "format_id": f.get("format_id"),
                "ext": f.get("ext"),
                "resolution": f.get("resolution") or (f"{f.get('width','?')}x{f.get('height','?')}" if f.get("width") else None),
                "height": f.get("height"),
                "fps": f.get("fps"),
                "vcodec": f.get("vcodec"),
                "acodec": f.get("acodec"),
                "filesize": f.get("filesize") or f.get("filesize_approx"),
                "tbr": f.get("tbr"),
                "format_note": f.get("format_note"),
            })
        _send({
            "id": req_id,
            "type": "formats",
            "title": info.get("title"),
            "duration": info.get("duration"),
            "thumbnail": info.get("thumbnail"),
            "uploader": info.get("uploader") or info.get("channel"),
            "formats": formats,
        })
    except subprocess.TimeoutExpired:
        _send({"id": req_id, "type": "done", "ok": False, "error": "yt-dlp probe timed out"})
    except Exception as e:
        _send({"id": req_id, "type": "done", "ok": False, "error": str(e)})


def _handle_download(req: dict) -> None:
    req_id = req.get("id", "")
    url = req.get("url", "")
    fmt = req.get("format") or "bv*+ba/b"
    out_dir = Path(req.get("outDir") or str(DEFAULT_OUTDIR))
    out_dir.mkdir(parents=True, exist_ok=True)

    ytdlp = _ytdlp_path()
    if not ytdlp:
        _send({"id": req_id, "type": "done", "ok": False, "error": "yt-dlp not found"})
        return

    # Include format_id in filename so different quality choices don't collide
    out_template = str(out_dir / "%(title).80s [%(id)s] [%(format_id)s].%(ext)s")
    cmd = [
        ytdlp,
        "-f", fmt,
        "--merge-output-format", "mp4",
        "--no-playlist",
        "--no-warnings",
        "--newline",
        "--progress",
        "-o", out_template,
        url,
    ]
    ffmpeg = _ffmpeg_path()
    if ffmpeg:
        cmd[-1:-1] = ["--ffmpeg-location", ffmpeg]
        _log(f"download: using ffmpeg at {ffmpeg}")
    else:
        _log("download: WARNING ffmpeg not found, merge will fail")

    try:
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            bufsize=1,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=_CREATE_NO_WINDOW,
        )
    except Exception as e:
        _send({"id": req_id, "type": "done", "ok": False, "error": f"failed to spawn yt-dlp: {e}"})
        return

    with _jobs_lock:
        _jobs[req_id] = proc
    _send({"id": req_id, "type": "started", "pid": proc.pid})

    final_file: str | None = None
    last_pct = -1.0
    try:
        assert proc.stdout is not None
        for line in proc.stdout:
            line = line.rstrip("\r\n")
            if not line:
                continue

            m = _PROGRESS_RE.search(line)
            if m:
                try:
                    pct = float(m.group("pct"))
                except Exception:
                    pct = 0.0
                if pct - last_pct >= 0.5 or pct >= 100:
                    last_pct = pct
                    _send({
                        "id": req_id,
                        "type": "progress",
                        "pct": pct,
                        "speed": m.group("speed"),
                        "eta": m.group("eta"),
                        "line": line,
                    })
                continue

            md = _MERGE_RE.search(line)
            if md:
                final_file = md.group(1)
                _send({"id": req_id, "type": "progress", "pct": 99.0, "line": line, "speed": None, "eta": None})
                continue

            dd = _DEST_RE.search(line)
            if dd and not final_file:
                final_file = dd.group(1).strip()
                continue

            # Bubble up non-progress info lines (warnings, etc.) but cap volume
            if line.startswith("ERROR") or line.startswith("WARNING"):
                _send({"id": req_id, "type": "log", "line": line})

        proc.wait()
        ok = proc.returncode == 0
        if ok and not final_file:
            # Best-effort: pick the newest video/audio file in out_dir (skip logs etc.)
            try:
                video_exts = {".mp4", ".webm", ".mkv", ".m4a", ".mp3", ".opus", ".ogg", ".aac", ".flac"}
                candidates = [p for p in out_dir.iterdir() if p.is_file() and p.suffix.lower() in video_exts]
                if candidates:
                    final_file = str(max(candidates, key=lambda p: p.stat().st_mtime))
            except Exception:
                pass
        if ok and not final_file:
            # Couldn't determine the output — treat as a soft failure to avoid lying
            ok = False
            error_msg = "yt-dlp finished but no output file was found (check format selection)"
        else:
            error_msg = None if ok else f"yt-dlp exit {proc.returncode}"
        _send({
            "id": req_id,
            "type": "done",
            "ok": ok,
            "exitCode": proc.returncode,
            "file": final_file,
            "error": error_msg,
        })
    except Exception as e:
        _send({"id": req_id, "type": "done", "ok": False, "error": f"{e}\n{traceback.format_exc()[:1000]}"})
    finally:
        with _jobs_lock:
            _jobs.pop(req_id, None)


def _handle_cancel(req: dict) -> None:
    req_id = req.get("id", "")
    with _jobs_lock:
        proc = _jobs.get(req_id)
    if proc is None:
        return
    try:
        proc.terminate()
    except Exception:
        pass


def _handle_pick_folder(req: dict) -> None:
    req_id = req.get("id", "")
    initial = req.get("initial") or str(DEFAULT_OUTDIR)
    chosen: str | None = None
    try:
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        try:
            chosen = filedialog.askdirectory(initialdir=initial, title="Pick a folder for Video Grabber downloads")
        finally:
            try:
                root.destroy()
            except Exception:
                pass
        if chosen:
            chosen = os.path.normpath(chosen)
    except Exception as e:
        _log(f"pick_folder error: {e}")
        _send({"id": req_id, "type": "folder_picked", "ok": False, "error": str(e)})
        return
    _log(f"pick_folder result: {chosen!r}")
    _send({"id": req_id, "type": "folder_picked", "ok": bool(chosen), "path": chosen or None})


def _dispatch(msg: dict) -> None:
    t = msg.get("type")
    if t == "probe":
        threading.Thread(target=_handle_probe, args=(msg,), daemon=True).start()
    elif t == "download":
        threading.Thread(target=_handle_download, args=(msg,), daemon=True).start()
    elif t == "cancel":
        _handle_cancel(msg)
    elif t == "pick_folder":
        threading.Thread(target=_handle_pick_folder, args=(msg,), daemon=True).start()


def main() -> None:
    _log(f"=== start, pid={os.getpid()}, py={sys.version.split()[0]} ===")
    ytdlp = _ytdlp_path()
    _log(f"ytdlp resolved to: {ytdlp}")
    _send({"type": "ready", "version": VERSION, "ytdlp": ytdlp or "(missing)"})
    while True:
        msg = _read_message()
        if msg is None:
            _log("exiting main loop")
            break
        try:
            _dispatch(msg)
        except Exception as e:
            _log(f"dispatch error: {e}\n{traceback.format_exc()}")
            _send({"type": "error", "error": str(e)})


if __name__ == "__main__":
    if os.name == "nt":
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    main()
