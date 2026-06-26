#!/usr/bin/env python3
"""画像振り分けツール - ローカルWebサーバ

指定したルートフォルダ配下（入れ子フォルダ含む）の画像を一覧表示し、
「保存」「削除」を素早く振り分けるためのローカルWebアプリ。
削除は完全削除ではなく <root>/_trash/ への移動（取り消し可能）。

Python標準ライブラリのみで動作（pip不要）。
起動:  python app.py  ->  http://127.0.0.1:8765/
"""

import json
import mimetypes
import os
import posixpath
import shutil
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

HOST = "127.0.0.1"
PORT = 8765
TRASH_DIRNAME = "_trash"
ALLOWED_EXT = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"}

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")


def is_image(name):
    return os.path.splitext(name)[1].lower() in ALLOWED_EXT


def safe_join(root, rel):
    """root + rel を結合し、root 配下に収まることを保証して絶対パスを返す。

    パストラバーサル（rel に .. を含む等）を拒否する。
    収まらない場合は ValueError。
    """
    root_real = os.path.realpath(root)
    if not os.path.isdir(root_real):
        raise ValueError("root is not a directory")
    # rel は posix 区切りで受け取り、OS 区切りへ正規化
    rel = (rel or "").replace("\\", "/").strip("/")
    target = os.path.realpath(os.path.join(root_real, *rel.split("/"))) if rel else root_real
    if target != root_real and not target.startswith(root_real + os.sep):
        raise ValueError("path escapes root")
    return target, root_real


def rel_from_root(root_real, path):
    """root_real からの相対パスを posix 区切りで返す。"""
    rel = os.path.relpath(path, root_real)
    return rel.replace(os.sep, "/")


def iter_image_dirs(root_real):
    """root 配下を再帰的に走査し、_trash を除いた各ディレクトリの絶対パスを yield。"""
    for dirpath, dirnames, _ in os.walk(root_real):
        # _trash 配下は走査しない（破壊的にスキップ）
        dirnames[:] = [d for d in dirnames if d != TRASH_DIRNAME]
        yield dirpath


def list_images_in_dir(root_real, dirpath):
    """dirpath 直下の画像を root 相対で列挙して返す。"""
    items = []
    try:
        entries = os.scandir(dirpath)
    except OSError:
        return items
    with entries:
        for entry in entries:
            if not entry.is_file() or not is_image(entry.name):
                continue
            try:
                st = entry.stat()
            except OSError:
                continue
            rel = rel_from_root(root_real, entry.path)
            subdir = posixpath.dirname(rel)
            items.append({
                "rel": rel,
                "name": entry.name,
                "subdir": subdir,
                "size": st.st_size,
                "mtime": st.st_mtime,
            })
    items.sort(key=lambda x: x["name"].lower())
    return items


def build_tree(root_real):
    """フォルダごとの画像枚数（直下のみ）を root 相対で返す。"""
    folders = []
    total = 0
    for dirpath in iter_image_dirs(root_real):
        count = sum(1 for e in os.scandir(dirpath)
                    if e.is_file() and is_image(e.name))
        if dirpath == root_real:
            rel = ""
            name = os.path.basename(root_real) or root_real
        else:
            rel = rel_from_root(root_real, dirpath)
            name = posixpath.basename(rel)
        folders.append({
            "rel": rel,
            "name": name,
            "depth": 0 if rel == "" else rel.count("/") + 1,
            "count": count,
        })
        total += count
    folders.sort(key=lambda f: f["rel"])
    return {"folders": folders, "total": total}


def unique_dest(dest_path):
    """dest_path が既に存在する場合、連番を付与して衝突しないパスを返す。"""
    if not os.path.exists(dest_path):
        return dest_path
    base, ext = os.path.splitext(dest_path)
    i = 1
    while True:
        candidate = f"{base}_{i}{ext}"
        if not os.path.exists(candidate):
            return candidate
        i += 1


class Handler(BaseHTTPRequestHandler):
    server_version = "ImageTriage/1.0"

    # --- ヘルパ ---------------------------------------------------------
    def _send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status, message):
        self._send_json({"error": message}, status=status)

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    # --- GET ------------------------------------------------------------
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        # keep_blank_values: scope="" を root 直下指定として保持する
        qs = parse_qs(parsed.query, keep_blank_values=True)

        if path == "/" or path == "/index.html":
            return self._serve_static("index.html")
        if path.startswith("/static/"):
            return self._serve_static(path[len("/static/"):])
        if path == "/api/tree":
            return self._api_tree(qs)
        if path == "/api/list":
            return self._api_list(qs)
        if path == "/img":
            return self._serve_image(qs)
        # 静的ファイルのフォールバック（index.html が ./app.js 等の相対パスで参照するため）
        candidate = path.lstrip("/")
        if candidate:
            full = os.path.realpath(os.path.join(STATIC_DIR, candidate.replace("/", os.sep)))
            if (full == STATIC_DIR or full.startswith(STATIC_DIR + os.sep)) and os.path.isfile(full):
                return self._serve_static(candidate)
        return self._error(404, "not found")

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            data = self._read_json_body()
        except (ValueError, json.JSONDecodeError):
            return self._error(400, "invalid JSON body")

        if path == "/api/trash":
            return self._api_trash(data)
        if path == "/api/restore":
            return self._api_restore(data)
        if path == "/api/empty_trash":
            return self._api_empty_trash(data)
        return self._error(404, "not found")

    # --- 静的ファイル ---------------------------------------------------
    def _serve_static(self, relpath):
        relpath = relpath.replace("\\", "/").lstrip("/")
        full = os.path.realpath(os.path.join(STATIC_DIR, relpath))
        if full != STATIC_DIR and not full.startswith(STATIC_DIR + os.sep):
            return self._error(403, "forbidden")
        if not os.path.isfile(full):
            return self._error(404, "not found")
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        with open(full, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # --- API ------------------------------------------------------------
    def _api_tree(self, qs):
        root = (qs.get("root", [""])[0]).strip()
        if not root:
            return self._error(400, "root が指定されていません")
        try:
            _, root_real = safe_join(root, "")
        except ValueError as e:
            return self._error(400, f"無効なフォルダ: {e}")
        return self._send_json(build_tree(root_real))

    def _api_list(self, qs):
        root = (qs.get("root", [""])[0]).strip()
        scope = qs.get("scope", ["all"])[0]
        if not root:
            return self._error(400, "root が指定されていません")
        try:
            _, root_real = safe_join(root, "")
        except ValueError as e:
            return self._error(400, f"無効なフォルダ: {e}")

        items = []
        if scope == "all":
            for dirpath in iter_image_dirs(root_real):
                items.extend(list_images_in_dir(root_real, dirpath))
            items.sort(key=lambda x: x["rel"].lower())
        else:
            try:
                target, _ = safe_join(root_real, scope)
            except ValueError as e:
                return self._error(400, f"無効なパス: {e}")
            if not os.path.isdir(target):
                return self._error(404, "フォルダが見つかりません")
            items = list_images_in_dir(root_real, target)
        return self._send_json({"items": items, "count": len(items)})

    def _serve_image(self, qs):
        root = (qs.get("root", [""])[0]).strip()
        rel = qs.get("rel", [""])[0]
        if not root or not rel:
            return self._error(400, "root と rel が必要です")
        try:
            target, _ = safe_join(root, rel)
        except ValueError as e:
            return self._error(400, f"無効なパス: {e}")
        if not os.path.isfile(target) or not is_image(target):
            return self._error(404, "画像が見つかりません")
        ctype = mimetypes.guess_type(target)[0] or "application/octet-stream"
        try:
            with open(target, "rb") as f:
                body = f.read()
        except OSError:
            return self._error(500, "読み込み失敗")
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _api_trash(self, data):
        root = (data.get("root") or "").strip()
        rel = data.get("rel") or ""
        if not root or not rel:
            return self._error(400, "root と rel が必要です")
        try:
            src, root_real = safe_join(root, rel)
        except ValueError as e:
            return self._error(400, f"無効なパス: {e}")
        if not os.path.isfile(src):
            return self._error(404, "ファイルが見つかりません")

        # _trash 内に元のサブフォルダ構造を保って移動
        rel_norm = rel_from_root(root_real, src)
        dest = os.path.join(root_real, TRASH_DIRNAME, *rel_norm.split("/"))
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        dest = unique_dest(dest)
        try:
            shutil.move(src, dest)
        except OSError as e:
            return self._error(500, f"移動失敗: {e}")
        trash_rel = rel_from_root(root_real, dest)
        return self._send_json({
            "ok": True,
            "rel": rel_norm,
            "trash_rel": trash_rel,
        })

    def _api_restore(self, data):
        root = (data.get("root") or "").strip()
        trash_rel = data.get("trash_rel") or ""
        orig_rel = data.get("rel") or ""
        if not root or not trash_rel or not orig_rel:
            return self._error(400, "root, trash_rel, rel が必要です")
        try:
            src, root_real = safe_join(root, trash_rel)
            dest_default, _ = safe_join(root_real, orig_rel)
        except ValueError as e:
            return self._error(400, f"無効なパス: {e}")
        if not os.path.isfile(src):
            return self._error(404, "ゴミ箱にファイルがありません")
        os.makedirs(os.path.dirname(dest_default), exist_ok=True)
        dest = unique_dest(dest_default)
        try:
            shutil.move(src, dest)
        except OSError as e:
            return self._error(500, f"復元失敗: {e}")
        return self._send_json({"ok": True, "rel": rel_from_root(root_real, dest)})

    def _api_empty_trash(self, data):
        root = (data.get("root") or "").strip()
        if not root:
            return self._error(400, "root が必要です")
        try:
            _, root_real = safe_join(root, "")
        except ValueError as e:
            return self._error(400, f"無効なフォルダ: {e}")
        trash = os.path.join(root_real, TRASH_DIRNAME)
        removed = 0
        if os.path.isdir(trash):
            for dirpath, _, files in os.walk(trash):
                removed += len(files)
            shutil.rmtree(trash, ignore_errors=True)
        return self._send_json({"ok": True, "removed": removed})

    # ログを簡潔に
    def log_message(self, fmt, *args):
        pass


def main():
    mimetypes.add_type("image/webp", ".webp")
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    url = f"http://{HOST}:{PORT}/"
    print("=" * 52)
    print("  画像振り分けツールを起動しました")
    print(f"  ブラウザで開いてください: {url}")
    print("  終了するには Ctrl+C を押してください")
    print("=" * 52)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n終了します。")
        server.shutdown()


if __name__ == "__main__":
    main()
