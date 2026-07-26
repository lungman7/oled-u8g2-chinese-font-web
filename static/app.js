/*
 * 瀏覽器端核心功能：
 * 1. 經使用者授權後，用 Local Font Access API 列出 Windows 全部安裝字型。
 * 2. 將指定文字畫到 Canvas 並轉成單色 BDF 點陣字型。
 * 3. 把 BDF 傳給樹莓派，再下載 bdfconv 產生的 U8g2 標頭檔。
 */

const form = document.querySelector("#font-form");
const textInput = document.querySelector("#text-input");
const fontSelect = document.querySelector("#font-select");
const fontSearch = document.querySelector("#font-search");
const fontAccessStatus = document.querySelector("#font-access-status");
const sizeSelect = document.querySelector("#size-select");
const variableInput = document.querySelector("#variable-input");
const charCount = document.querySelector("#char-count");
const preview = document.querySelector("#glyph-preview");
const previewMeta = document.querySelector("#preview-meta");
const message = document.querySelector("#form-message");
const generateButton = document.querySelector("#generate-button");
const fontCatalog = new Map();
let activeFontFamily = "";
let activeFontKey = "";
let fontLoadToken = 0;
let renderTimer;

/**
 * 讀取 Windows 註冊的全部字型「名稱與樣式」。
 * queryLocalFonts() 必須由按鈕等使用者操作觸發；此階段不呼叫 blob()，
 * 因此只建立下拉清單，尚未讀取任何一個字型的實際檔案內容。
 */
async function scanInstalledFonts() {
  fontAccessStatus.textContent = "正在等候瀏覽器授權…";
  message.textContent = "";

  if (!window.isSecureContext || !("queryLocalFonts" in window)) {
    fontAccessStatus.textContent = "此網址或瀏覽器不支援完整列舉";
    message.textContent = "請改用網站的 HTTPS 網址與桌面版 Chrome／Edge，或使用下方的字型檔選取功能。";
    message.className = "form-message error";
    return;
  }

  try {
    const fonts = await window.queryLocalFonts();
    fontCatalog.clear();

    const collator = new Intl.Collator("zh-Hant", { numeric: true, sensitivity: "base" });
    fonts
      .map((font, index) => ({
        key: `system-${index}`,
        displayName: font.fullName || `${font.family} ${font.style}`.trim(),
        family: font.family || font.fullName,
        style: font.style || "Regular",
        postscriptName: font.postscriptName || "",
        fontData: font,
        source: "Windows 系統字型"
      }))
      .sort((a, b) => collator.compare(a.displayName, b.displayName))
      .forEach((record) => fontCatalog.set(record.key, record));

    refreshFontOptions();
    fontSearch.disabled = false;
    fontSelect.disabled = false;
    fontAccessStatus.textContent = `已取得 ${fontCatalog.size} 個字型樣式；請從下拉選單選擇`;
    message.textContent = "已讀取 Windows 安裝字型名稱。實際字型內容會在選取後才載入。";
    message.className = "form-message success";
  } catch (error) {
    fontAccessStatus.textContent = "未取得本機字型權限";
    const denied = error?.name === "NotAllowedError";
    message.textContent = denied
      ? "你未允許網站讀取本機字型；可重新按下授權按鈕，或改用字型檔選取功能。"
      : `無法讀取本機字型：${error.message || "瀏覽器未提供原因"}`;
    message.className = "form-message error";
  }
}

/** 依搜尋文字重建原生下拉選單；所有字型仍保留在記憶體目錄中。 */
function refreshFontOptions(filter = "") {
  const keyword = filter.trim().toLocaleLowerCase("zh-Hant");
  const previous = fontSelect.value;
  fontSelect.innerHTML = '<option value="">— 請選擇一個已安裝字型 —</option>';
  for (const record of fontCatalog.values()) {
    const searchable = `${record.displayName} ${record.family} ${record.style} ${record.postscriptName}`.toLocaleLowerCase("zh-Hant");
    if (keyword && !searchable.includes(keyword)) continue;
    const option = document.createElement("option");
    option.value = record.key;
    option.textContent = `${record.displayName}${record.style && !record.displayName.includes(record.style) ? ` — ${record.style}` : ""}`;
    fontSelect.append(option);
  }
  if ([...fontSelect.options].some((option) => option.value === previous)) {
    fontSelect.value = previous;
  }
}

/**
 * 真正選中後才呼叫 FontData.blob() 取得該字型的 SFNT 資料。
 * 建立專用 FontFace 後，Canvas 只會使用這個已選字型繪製輸入文字。
 */
async function activateSelectedFont() {
  const key = fontSelect.value;
  const record = fontCatalog.get(key);
  const token = ++fontLoadToken;
  activeFontFamily = "";
  activeFontKey = "";
  generateButton.disabled = true;
  preview.innerHTML = '<span class="preview-placeholder">請選擇字型</span>';
  if (!record) return;

  fontAccessStatus.textContent = `正在載入「${record.displayName}」…`;
  try {
    const blob = record.fontData ? await record.fontData.blob() : record.file;
    if (token !== fontLoadToken) return;
    const objectUrl = URL.createObjectURL(blob);
    const alias = `selected-font-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const face = new FontFace(alias, `url("${objectUrl}")`);
    try {
      await face.load();
      document.fonts.add(face);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
    if (token !== fontLoadToken) return;
    activeFontFamily = alias;
    activeFontKey = key;
    generateButton.disabled = false;
    fontAccessStatus.textContent = `已選取：${record.displayName}`;
    message.textContent = `字型已載入；產生器只會擷取輸入文字中的 ${uniqueCharacters().length} 個不同字元。`;
    message.className = "form-message success";
    scheduleRender();
  } catch (error) {
    fontAccessStatus.textContent = `無法載入：${record.displayName}`;
    message.textContent = `所選字型無法由瀏覽器讀取：${error.message || "未知格式"}`;
    message.className = "form-message error";
  }
}

/** 不支援 Local Font Access 時，讓使用者明確選取 Windows Fonts 內的檔案。 */
function addSelectedFontFiles(files) {
  fontCatalog.clear();
  [...files]
    .sort((a, b) => a.name.localeCompare(b.name, "zh-Hant", { numeric: true }))
    .forEach((file, index) => {
      const displayName = file.name.replace(/\.(ttf|otf|ttc|woff2?)$/i, "");
      const record = {
        key: `file-${index}`,
        displayName,
        family: displayName,
        style: "",
        postscriptName: "",
        file,
        source: "手動選取字型檔"
      };
      fontCatalog.set(record.key, record);
    });
  refreshFontOptions();
  fontSearch.disabled = false;
  fontSelect.disabled = false;
  fontAccessStatus.textContent = `已加入 ${fontCatalog.size} 個字型檔；請選擇要使用的字型`;
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
  return fontCatalog.get(activeFontKey)?.displayName || "尚未選擇字型";
}

function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(renderPreview, 100);
}

/** 用相同 rasterizeGlyph 結果畫預覽，確保畫面與下載字模一致。 */
function renderPreview() {
  const characters = uniqueCharacters();
  const size = Number(sizeSelect.value);
  const family = activeFontFamily;
  charCount.textContent = `${characters.length} / 256`;
  charCount.classList.toggle("over-limit", characters.length > 256);
  previewMeta.textContent = `${size} × ${size} px · ${selectedFontName()}`;
  preview.innerHTML = "";

  if (!family) {
    preview.innerHTML = '<span class="preview-placeholder">授權並選擇字型後顯示點陣預覽</span>';
    updateExample();
    return;
  }

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
[textInput, variableInput].forEach((element) => element.addEventListener("input", scheduleRender));
fontSelect.addEventListener("change", activateSelectedFont);
fontSearch.addEventListener("input", () => refreshFontOptions(fontSearch.value));
document.querySelector("#scan-fonts").addEventListener("click", scanInstalledFonts);
document.querySelector("#choose-font-files").addEventListener("click", () => {
  document.querySelector("#font-files").click();
});
document.querySelector("#font-files").addEventListener("change", (event) => {
  if (event.target.files.length) addSelectedFontFiles(event.target.files);
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
  if (!activeFontFamily || activeFontKey !== fontSelect.value) {
    message.textContent = "請先從下拉選單選取並成功載入一個字型。";
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
        bdf: buildBdf(characters, size, activeFontFamily),
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
    generateButton.disabled = !activeFontFamily;
    generateButton.querySelector("span").textContent = "產生並下載 .h 字型庫";
  }
});

generateButton.disabled = true;
renderPreview();
