# 字鑄所：OLED U8g2 中文字型庫產生器

這是一個部署於 Raspberry Pi 的網頁工具。使用者可輸入 Arduino 程式需要
顯示的中文字、選擇電腦已安裝的中文字型及 16×16、24×24、32×32、
48×48 尺寸，下載可直接由 U8g2 `setFont()` 與 `drawUTF8()` 使用的 `.h`
字型庫。

## 功能與資料流程

1. 網頁透過瀏覽器 `FontFace` API 檢查常見中文字型名稱。
2. 選到的本機字型只在使用者電腦上由 Canvas 繪成單色點陣。
3. 瀏覽器將點陣組成 BDF；不會上傳完整的本機字型檔。
4. Flask 後端驗證輸入，再呼叫 U8g2 官方 `bdfconv` 產生 C 字型陣列。
5. 下載檔案已含 `#pragma once`、來源資訊與中文使用說明。

## 本機開發

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export BDFCONV=/path/to/bdfconv
python app.py
```

開啟 `http://127.0.0.1:8082/`。正式環境使用 `gunicorn.conf.py`，不應使用
Flask 的開發伺服器。

## Arduino 使用方式

1. 在 Arduino IDE 的函式庫管理員安裝 `U8g2`。
2. 將下載的 `.h` 檔放在 sketch（`.ino`）同一資料夾。
3. 在 `.ino` 加入 `#include "u8g2_font_zh_custom_24.h"`。
4. 設定字型後用 UTF-8 字串顯示：

```cpp
u8g2.setFont(u8g2_font_zh_custom_24);
u8g2.setFontPosTop();
u8g2.drawUTF8(0, 0, "溫度正常");
```

只有建立字型庫時輸入過的字元能被顯示。大量或 48×48 字模會占用較多
Flash，建議只收錄產品實際使用的字。

## 主要程式碼

- `app.py`：API、輸入驗證、bdfconv 呼叫與下載檔包裝。
- `static/app.js`：本機字型偵測、Canvas 點陣化、BDF 建立及互動。
- `static/style.css`：響應式視覺樣式與無障礙狀態。
- `templates/index.html`：操作介面、Arduino 範例與完整教學。
- `deploy/`：Raspberry Pi systemd、Nginx 與安裝腳本。

程式碼內附有詳細中文註解，可由各函式的 docstring 與區塊註解了解用途。
