"""OLED U8g2 中文字型庫產生器的 Flask 後端。

瀏覽器負責把本機字型畫成單色 BDF 點陣；此後端只做輸入驗證、呼叫
U8g2 官方 bdfconv 轉檔，並把可直接 include 的 .h 檔回傳給使用者。
"""

from __future__ import annotations

import os
import re
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, Response, jsonify, render_template, request
from werkzeug.middleware.proxy_fix import ProxyFix

app = Flask(__name__)
# 網站放在 Nginx 反向代理後方，採用代理傳來的協定與主機資訊。
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1)
app.config["MAX_CONTENT_LENGTH"] = 8 * 1024 * 1024

ALLOWED_SIZES = {16, 24, 32, 48}
MAX_GLYPHS = 256
VARIABLE_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,62}$")


@app.get("/")
def index() -> str:
    """顯示單頁式產生器介面。"""
    return render_template("index.html")


@app.get("/api/health")
def health() -> Response:
    """供部署腳本與監控確認服務是否正常。"""
    return jsonify(status="ok", converter=_find_bdfconv())


@app.post("/api/generate")
def generate_font() -> Response:
    """把瀏覽器產生的 BDF 轉成 U8g2 C 標頭檔並回傳下載。"""
    payload = request.get_json(silent=True) or {}
    bdf = payload.get("bdf", "")
    text = payload.get("text", "")
    font_name = payload.get("fontName", "本機中文字型")
    variable = payload.get("variable", "")

    try:
        size = int(payload.get("size", 0))
    except (TypeError, ValueError):
        size = 0

    error = _validate_request(bdf, text, size, variable)
    if error:
        return jsonify(error=error), 400

    converter = _find_bdfconv()
    if not converter:
        return jsonify(error="伺服器尚未安裝 bdfconv，請聯絡管理者。"), 503

    # 字元先去重但保留原順序；空白固定加入，方便 drawUTF8 顯示句子。
    characters = list(dict.fromkeys(text))
    codepoints = sorted({ord(char) for char in characters} | {32})
    map_argument = ",".join(str(value) for value in codepoints)

    with tempfile.TemporaryDirectory(prefix="u8g2-font-") as temp_dir:
        source = Path(temp_dir) / "source.bdf"
        output = Path(temp_dir) / "font.h"
        source.write_text(bdf, encoding="ascii")

        command = [
            converter,
            "-f",
            "1",
            "-m",
            map_argument,
            "-n",
            variable,
            "-o",
            str(output),
            str(source),
        ]
        try:
            result = subprocess.run(
                command,
                capture_output=True,
                text=True,
                timeout=20,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return jsonify(error="轉換逾時，請減少字數後再試一次。"), 504

        if result.returncode != 0 or not output.exists():
            app.logger.error("bdfconv failed: %s", result.stderr or result.stdout)
            return jsonify(error="字型轉換失敗，請確認文字與字型後再試。"), 422

        generated = output.read_text(encoding="utf-8", errors="replace")
        header = _build_header(generated, text, font_name, size, variable)
        filename = f"{variable}.h"
        return Response(
            header,
            mimetype="text/x-c; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )


def _validate_request(bdf: object, text: object, size: int, variable: object) -> str | None:
    """集中驗證所有外部輸入，避免命令注入與過大的轉換工作。"""
    if not isinstance(text, str) or not text.strip():
        return "請先輸入至少一個要顯示的中文字。"
    unique_count = len(set(text))
    if unique_count > MAX_GLYPHS:
        return f"單次最多可建立 {MAX_GLYPHS} 個不同字元，目前為 {unique_count} 個。"
    if any(ord(char) > 0xFFFF for char in text):
        return "U8g2 字型格式僅支援 Unicode BMP 字元，請移除表情符號或罕見擴充字。"
    if size not in ALLOWED_SIZES:
        return "字體大小必須是 16、24、32 或 48。"
    if not isinstance(variable, str) or not VARIABLE_PATTERN.fullmatch(variable):
        return "字型變數名稱只能使用英文字母、數字與底線，且不能以數字開頭。"
    if not isinstance(bdf, str) or not bdf.startswith("STARTFONT 2.1"):
        return "瀏覽器傳來的 BDF 字型資料格式不正確。"
    if len(bdf.encode("ascii", errors="ignore")) > 7 * 1024 * 1024:
        return "產生的字型資料過大，請減少字元數或選擇較小尺寸。"
    if "\x00" in bdf:
        return "字型資料包含不允許的內容。"
    return None


def _find_bdfconv() -> str | None:
    """依序尋找環境變數與常見安裝位置中的 bdfconv。"""
    candidates = [
        os.environ.get("BDFCONV"),
        "/usr/local/bin/bdfconv",
        "/usr/bin/bdfconv",
        str(Path(__file__).parent / "vendor" / "bdfconv"),
    ]
    for candidate in candidates:
        if candidate and Path(candidate).is_file() and os.access(candidate, os.X_OK):
            return candidate
    return None


def _build_header(
    generated: str, text: str, font_name: str, size: int, variable: str
) -> str:
    """在官方轉換結果前加入中文說明與 include 防護。"""
    safe_preview = text.replace("*/", "* /").replace("\r", " ").replace("\n", " ")[:120]
    safe_font = str(font_name).replace("*/", "* /").replace("\r", " ").replace("\n", " ")[:100]
    generated_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    return f"""#pragma once
/*
 * 由 OLED U8g2 中文字型庫產生器建立
 * 建立時間：{generated_at}
 * 原始字型：{safe_font}
 * 點陣大小：{size} x {size}
 * 收錄文字：{safe_preview}
 *
 * 使用方式：
 *   1. 將本檔放入 Arduino sketch 同一個資料夾。
 *   2. 在 .ino 開頭加入 #include "{variable}.h"
 *   3. 顯示前呼叫 u8g2.setFont({variable});
 *   4. 使用 u8g2.drawUTF8(x, y, "中文字")，並將程式存成 UTF-8。
 */

{generated}
"""


@app.errorhandler(413)
def request_too_large(_error: Exception) -> tuple[Response, int]:
    """回傳容易理解的 JSON，而不是 Flask 預設 HTML 錯誤頁。"""
    return jsonify(error="資料超過 8 MB，請減少字元數或字型大小。"), 413


if __name__ == "__main__":
    # 僅供本機開發；正式環境由 Gunicorn 啟動。
    app.run(host="127.0.0.1", port=8082, debug=True)
