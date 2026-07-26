/*
 * 瀏覽器端核心功能：
 * 1. 以 FontFace local() 檢查常見中文字型是否存在。
 * 2. 將指定文字畫到 Canvas 並轉成單色 BDF 點陣字型。
 * 3. 把 BDF 傳給樹莓派，再下載 bdfconv 產生的 U8g2 標頭檔。
 */

const COMMON_CJK_FONTS = [
  "Microsoft JhengHei UI", "Microsoft JhengHei", "DFKai-SB", "PMingLiU",
  "MingLiU", "MingLiU_HKSCS", "Noto Sans TC", "Noto Serif TC",
  "Source Han Sans TC", "Source Han Serif TC", "PingFang TC",
  "Heiti TC", "Songti TC", "Kaiti TC", "Microsoft YaHei UI",
  "Microsoft YaHei", "SimSun", "SimHei", "KaiTi", "Arial Unicode MS"
];

const form = document.querySelector("#font-form");
const textInput = document.querySelector("#text-input");
const fontSelect = document.querySelector("#font-select");
const sizeSelect = document.querySelector("#size-select");
const variableInput = document.querySelector("#variable-input");
const charCount = document.querySelector("#char-count");
const preview = document.querySelector("#glyph-preview");
const previewMeta = document.querySelector("#preview-meta");
const message = document.querySelector("#form-message");
const generateButton = document.querySelector("#generate-button");
let renderTimer;

/**
 * local() 只在字型真的安裝時才會成功，比量測文字寬度更不容易誤判。
 * 每個測試字型使用獨立的暫時名稱，成功後保留供 Canvas 繪製。
 */
async function probeLocalFont(fontName, index) {
  const alias = `detected-font-${index}-${Date.now()}`;
  const face = new FontFace(alias, `local("${fontName.replaceAll('"', '\\"')}")`);
  try {
    await face.load();
    document.fonts.add(face);
    return { name: fontName, family: alias };
  } catch {
    return null;
  }
}

async function detectFonts() {
  fontSelect.innerHTML = '<option value="">正在偵測這台電腦的字型…</option>';
  const results = await Promise.all(COMMON_CJK_FONTS.map(probeLocalFont));
  const installed = results.filter(Boolean);
  fontSelect.innerHTML = "";

  if (!installed.length) {
    addFontOption("系統預設中文字型", "sans-serif", true);
    message.textContent = "未找到常見字型名稱，已改用系統預設中文字型。";
  } else {
    installed.forEach((font, index) => addFontOption(font.name, font.family, index === 0));
  }
  scheduleRender();
}

function addFontOption(label, family, selected = false) {
  const option = document.createElement("option");
  option.textContent = label;
  option.value = family;
  option.dataset.displayName = label;
  option.selected = selected;
  fontSelect.append(option);
}

/** 傳回去重且保留原輸入順序的字元，換行與歸零字元不建立字模。 */
function uniqueCharacters() {
  return [...new Set([...textInput.value].filter((char) => char !== "\r" && char !== "\n" && char !== "\0"))];
}

/**
 * 以實際字形邊界計算縮放比例，將每個字置中放進固定 N×N 方格。
 * Canvas 先用較大基準字測量，再依邊界縮放，避免不同字型被裁切。
 */
function rasterizeGlyph(character, size, family) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.clearRect(0, 0, size, size);
  context.fillStyle = "#fff";
  context.textBaseline = "alphabetic";

  if (character === " ") {
    return new Array(size).fill("00".repeat(Math.ceil(size / 8)));
  }

  const referenceSize = 100;
  context.font = `${referenceSize}px "${family}", sans-serif`;
  let metrics = context.measureText(character);
  const glyphWidth = Math.max(1, metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight);
  const glyphHeight = Math.max(1, metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent);
  const margin = Math.max(1, Math.round(size * 0.04));
  const fontSize = referenceSize * Math.min(
    (size - margin * 2) / glyphWidth,
    (size - margin * 2) / glyphHeight
  );

  context.font = `${fontSize}px "${family}", sans-serif`;
  metrics = context.measureText(character);
  const width = metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight;
  const height = metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent;
  const left = (size - width) / 2;
  const top = (size - height) / 2;
  const x = left + metrics.actualBoundingBoxLeft;
  const baseline = top + metrics.actualBoundingBoxAscent;
  context.fillText(character, x, baseline);

  const pixels = context.getImageData(0, 0, size, size).data;
  const bytesPerRow = Math.ceil(size / 8);
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    const bytes = [];
    for (let byteIndex = 0; byteIndex < bytesPerRow; byteIndex += 1) {
      let value = 0;
      for (let bit = 0; bit < 8; bit += 1) {
        const xPixel = byteIndex * 8 + bit;
        if (xPixel < size) {
          const alpha = pixels[(y * size + xPixel) * 4 + 3];
          if (alpha >= 96) value |= 1 << (7 - bit);
        }
      }
      bytes.push(value.toString(16).padStart(2, "0").toUpperCase());
    }
    rows.push(bytes.join(""));
  }
  return rows;
}

/** 組成 bdfconv 可讀的 BDF 2.1 檔，每個 glyph 都是固定方形點陣。 */
function buildBdf(characters, size, family) {
  const glyphs = characters.includes(" ") ? characters : [" ", ...characters];
  const lines = [
    "STARTFONT 2.1",
    `FONT -WEB-LOCAL-MEDIUM-R-NORMAL--${size}-${size * 10}-75-75-C-${size * 10}-ISO10646-1`,
    `SIZE ${size} 75 75`,
    `FONTBOUNDINGBOX ${size} ${size} 0 0`,
    "STARTPROPERTIES 4",
    `FONT_ASCENT ${size}`,
    "FONT_DESCENT 0",
    'DEFAULT_CHAR 32',
    'CHARSET_REGISTRY "ISO10646"',
    "ENDPROPERTIES",
    `CHARS ${glyphs.length}`
  ];

  glyphs.forEach((character) => {
    const codepoint = character.codePointAt(0);
    lines.push(
      `STARTCHAR U+${codepoint.toString(16).toUpperCase().padStart(4, "0")}`,
      `ENCODING ${codepoint}`,
      "SWIDTH 1000 0",
      `DWIDTH ${size} 0`,
      `BBX ${size} ${size} 0 0`,
      "BITMAP",
      ...rasterizeGlyph(character, size, family),
      "ENDCHAR"
    );
  });
  lines.push("ENDFONT", "");
  return lines.join("\n");
}

function selectedFontName() {
  return fontSelect.selectedOptions[0]?.dataset.displayName || "系統預設中文字型";
}

function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(renderPreview, 100);
}

/** 用相同 rasterizeGlyph 結果畫預覽，確保畫面與下載字模一致。 */
function renderPreview() {
  const characters = uniqueCharacters();
  const size = Number(sizeSelect.value);
  const family = fontSelect.value || "sans-serif";
  charCount.textContent = `${characters.length} / 256`;
  charCount.classList.toggle("over-limit", characters.length > 256);
  previewMeta.textContent = `${size} × ${size} px · ${selectedFontName()}`;
  preview.innerHTML = "";

  characters.slice(0, 18).forEach((character) => {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    canvas.title = character === " " ? "空白" : character;
    const rows = rasterizeGlyph(character, size, family);
    const context = canvas.getContext("2d");
    const image = context.createImageData(size, size);
    rows.forEach((row, y) => {
      const bytes = row.match(/.{2}/g).map((value) => Number.parseInt(value, 16));
      for (let x = 0; x < size; x += 1) {
        const on = (bytes[Math.floor(x / 8)] & (1 << (7 - (x % 8)))) !== 0;
        const index = (y * size + x) * 4;
        const color = on ? 216 : 20;
        image.data.set([color, on ? 255 : 23, on ? 238 : 32, 255], index);
      }
    });
    context.putImageData(image, 0, 0);
    preview.append(canvas);
  });
  if (characters.length > 18) {
    const more = document.createElement("span");
    more.className = "more-glyphs";
    more.textContent = `+${characters.length - 18}`;
    preview.append(more);
  }
  updateExample();
}

function updateExample() {
  const variable = variableInput.value || "u8g2_font_zh_custom";
  const displayText = textInput.value.replaceAll("\n", "").slice(0, 12) || "中文字";
  document.querySelector("#header-name").textContent = `${variable}.h`;
  document.querySelector("#arduino-code").textContent = `#include <Arduino.h>
#include <U8g2lib.h>
#include "${variable}.h"

// 請依 OLED 型號修改建構式
U8G2_SSD1306_128X64_NONAME_F_HW_I2C u8g2(
  U8G2_R0, U8X8_PIN_NONE
);

void setup() {
  u8g2.begin();
  u8g2.enableUTF8Print();
}

void loop() {
  u8g2.clearBuffer();
  u8g2.setFont(${variable});
  u8g2.setFontPosTop();
  u8g2.drawUTF8(0, 0, "${displayText.replaceAll('"', '\\"')}");
  u8g2.sendBuffer();
  delay(1000);
}`;
}

sizeSelect.addEventListener("change", () => {
  const previousSize = variableInput.value.match(/_(16|24|32|48)$/);
  if (previousSize) variableInput.value = variableInput.value.replace(/_(16|24|32|48)$/, `_${sizeSelect.value}`);
  scheduleRender();
});
[textInput, fontSelect, variableInput].forEach((element) => element.addEventListener("input", scheduleRender));

document.querySelector("#add-font").addEventListener("click", async () => {
  const input = document.querySelector("#custom-font-name");
  const name = input.value.trim();
  if (!name) return;
  const found = await probeLocalFont(name, `custom-${Date.now()}`);
  if (!found) {
    message.textContent = `找不到「${name}」，請確認作業系統顯示的完整字型名稱。`;
    message.className = "form-message error";
    return;
  }
  addFontOption(found.name, found.family, true);
  message.textContent = `已加入本機字型「${name}」。`;
  message.className = "form-message success";
  input.value = "";
  scheduleRender();
});

document.querySelector("#copy-code").addEventListener("click", async (event) => {
  await navigator.clipboard.writeText(document.querySelector("#arduino-code").textContent);
  event.currentTarget.textContent = "已複製";
  setTimeout(() => { event.currentTarget.textContent = "複製程式"; }, 1500);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const characters = uniqueCharacters();
  if (!characters.length || characters.length > 256) {
    message.textContent = characters.length ? "不同字元不可超過 256 個。" : "請先輸入要收錄的文字。";
    message.className = "form-message error";
    return;
  }

  generateButton.disabled = true;
  generateButton.querySelector("span").textContent = "正在鑄造字型庫…";
  message.textContent = "正在把點陣轉成 U8g2 格式，請稍候。";
  message.className = "form-message";

  try {
    const size = Number(sizeSelect.value);
    const response = await fetch("api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bdf: buildBdf(characters, size, fontSelect.value || "sans-serif"),
        text: characters.join(""),
        fontName: selectedFontName(),
        size,
        variable: variableInput.value
      })
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error || "伺服器無法產生字型庫。");
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${variableInput.value}.h`;
    link.click();
    URL.revokeObjectURL(url);
    message.textContent = "完成！.h 字型庫已下載，請依右側步驟加入 Arduino。";
    message.className = "form-message success";
  } catch (error) {
    message.textContent = error.message;
    message.className = "form-message error";
  } finally {
    generateButton.disabled = false;
    generateButton.querySelector("span").textContent = "產生並下載 .h 字型庫";
  }
});

detectFonts();
