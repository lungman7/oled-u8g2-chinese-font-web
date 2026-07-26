#!/usr/bin/env bash
# 在 Raspberry Pi OS 安裝 Python 環境、U8g2 官方 bdfconv 與 systemd 服務。
set -euo pipefail

APP_DIR="/home/pi5/oled_u8g2_font_web"
U8G2_CACHE="/home/pi5/.cache/u8g2-font-tools"

sudo apt-get update
sudo apt-get install -y python3-venv git make gcc

python3 -m venv "${APP_DIR}/.venv"
"${APP_DIR}/.venv/bin/pip" install --upgrade pip
"${APP_DIR}/.venv/bin/pip" install -r "${APP_DIR}/requirements.txt"

# bdfconv 是 U8g2 專案官方的 BDF → C 陣列轉換器。
if [[ ! -x /usr/local/bin/bdfconv ]]; then
  rm -rf "${U8G2_CACHE}"
  git clone --depth 1 https://github.com/olikraus/u8g2.git "${U8G2_CACHE}"
  make -C "${U8G2_CACHE}/tools/font/bdfconv"
  sudo install -m 0755 "${U8G2_CACHE}/tools/font/bdfconv/bdfconv" /usr/local/bin/bdfconv
fi

sudo install -m 0644 "${APP_DIR}/deploy/oled-u8g2-font.service" /etc/systemd/system/oled-u8g2-font.service
sudo systemctl daemon-reload
sudo systemctl enable --now oled-u8g2-font.service
