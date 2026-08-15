/**
 * ============================================================================
 * AUTOMATION SYSTEM - Video Processing Script
 * ============================================================================
 * Project: waqas-ai-studio
 * GitHub: https://github.com/waqaskhan1437/waqas-ai-studio
 * GitHub Actions: Video Processing Runner
 * 
 * This script processes videos for automation with features:
 * - Advanced audio muting (full_mute, fade_out, mute_last, mute_range)
 * - Video cropping/scaling
 * - Tagline overlays
 * - Split/combine modes
 * 
 * Deployed via: GitHub Actions self-hosted runners
 * ============================================================================
 */

const { execSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const OUTPUT_DIR = process.env.OUTPUT_DIR
  ? path.resolve(process.env.OUTPUT_DIR)
  : process.env.OUTPUT_FILE_PATH
  ? path.dirname(path.resolve(process.env.OUTPUT_FILE_PATH))
  : path.join(process.cwd(), "output");
const INPUT_FILE = process.env.INPUT_FILE_PATH ? path.resolve(process.env.INPUT_FILE_PATH) : path.join(OUTPUT_DIR, "input-video.mp4");
const OUTPUT_FILE = process.env.OUTPUT_FILE_PATH ? path.resolve(process.env.OUTPUT_FILE_PATH) : path.join(OUTPUT_DIR, "processed-video.mp4");
const TEMP_FILE = process.env.TEMP_FILE_PATH ? path.resolve(process.env.TEMP_FILE_PATH) : path.join(OUTPUT_DIR, "temp-noaudio.mp4");
const SPEED_FILE = process.env.SPEED_FILE_PATH ? path.resolve(process.env.SPEED_FILE_PATH) : path.join(OUTPUT_DIR, "temp-speed.mp4");
const OVERLAY_FILE = process.env.OVERLAY_FILE_PATH ? path.resolve(process.env.OVERLAY_FILE_PATH) : path.join(OUTPUT_DIR, "temp-overlay.mp4");
const AUDIOTRACK_FILE = path.join(OUTPUT_DIR, "temp-audiotracks.mp4");

function getCommandCandidates(name) {
  const isWin = process.platform === "win32";
  const extension = isWin ? ".exe" : "";
  return [
    path.resolve(__dirname, "..", "local-runner", "tools", "ffmpeg", "bin", `${name}${extension}`),
    path.resolve(__dirname, "tools", "ffmpeg", "bin", `${name}${extension}`),
    path.resolve(process.cwd(), `${name}${extension}`),
  ];
}

function resolveCommand(name) {
  for (const candidate of getCommandCandidates(name)) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  if (process.platform === "win32") {
    for (const dir of (process.env.PATH || "").split(path.delimiter)) {
      if (!dir || /[\\/]WindowsApps([\\/]|$)/i.test(dir)) continue;
      const full = path.join(dir, `${name}.exe`);
      if (fs.existsSync(full)) return full;
    }
  }

  return name;
}

function quoteCommand(command) {
  return command.includes(" ") || command.includes("\\") ? `"${command}"` : command;
}

const FFMPEG = quoteCommand(resolveCommand("ffmpeg"));
const FFPROBE = quoteCommand(resolveCommand("ffprobe"));

function copyFileSync(source, destination) {
  fs.copyFileSync(source, destination);
  console.log(`Copied file: ${source} -> ${destination}`);
}

const FONT_DIR = (() => {
  if (process.platform === "win32") {
    return "C:/Windows/Fonts";
  } else if (process.platform === "darwin") {
    return "/System/Library/Fonts";
  } else {
    return "/usr/share/fonts/truetype";
  }
})();

const WINDOWS_FONT_MAP = {
  ubuntu: {
    normal: ["arial.ttf", "segoeui.ttf", "calibri.ttf"],
    medium: ["arial.ttf", "segoeui.ttf", "calibri.ttf"],
    bold: ["arialbd.ttf", "segoeuib.ttf", "calibrib.ttf"],
    italic: ["ariali.ttf", "segoeuii.ttf", "calibrii.ttf"],
    medium_italic: ["ariali.ttf", "segoeuii.ttf", "calibrii.ttf"],
    bold_italic: ["arialbi.ttf", "segoeuiz.ttf", "calibriz.ttf"]
  },
  dejavu: {
    normal: ["verdana.ttf", "arial.ttf"],
    medium: ["verdana.ttf", "arial.ttf"],
    bold: ["verdanab.ttf", "arialbd.ttf"],
    italic: ["verdanai.ttf", "ariali.ttf"],
    medium_italic: ["verdanai.ttf", "ariali.ttf"],
    bold_italic: ["verdanaz.ttf", "arialbi.ttf"]
  },
  liberation: {
    normal: ["arial.ttf", "calibri.ttf"],
    medium: ["arial.ttf", "calibri.ttf"],
    bold: ["arialbd.ttf", "calibrib.ttf"],
    italic: ["ariali.ttf", "calibrii.ttf"],
    medium_italic: ["ariali.ttf", "calibrii.ttf"],
    bold_italic: ["arialbi.ttf", "calibriz.ttf"]
  },
  noto: {
    normal: ["tahoma.ttf", "arial.ttf"],
    medium: ["tahoma.ttf", "arial.ttf"],
    bold: ["tahomabd.ttf", "arialbd.ttf"],
    italic: ["ariali.ttf", "verdanai.ttf"],
    medium_italic: ["ariali.ttf", "verdanai.ttf"],
    bold_italic: ["arialbi.ttf", "verdanaz.ttf"]
  },
  nimbus: {
    normal: ["times.ttf", "arial.ttf"],
    medium: ["times.ttf", "arial.ttf"],
    bold: ["timesbd.ttf", "arialbd.ttf"],
    italic: ["timesi.ttf", "ariali.ttf"],
    medium_italic: ["timesi.ttf", "ariali.ttf"],
    bold_italic: ["timesbi.ttf", "arialbi.ttf"]
  },
  lato: {
    normal: ["calibri.ttf", "arial.ttf"],
    medium: ["calibril.ttf", "calibri.ttf", "arial.ttf"],
    bold: ["calibrib.ttf", "arialbd.ttf"],
    italic: ["calibrii.ttf", "ariali.ttf"],
    medium_italic: ["calibrili.ttf", "calibrii.ttf", "ariali.ttf"],
    bold_italic: ["calibriz.ttf", "arialbi.ttf"]
  }
};

const FONT_MAP = {
  ubuntu: {
    normal: "ubuntu/Ubuntu-R.ttf",
    medium: "ubuntu/Ubuntu-M.ttf",
    bold: "ubuntu/Ubuntu-B.ttf",
    italic: "ubuntu/Ubuntu-RI.ttf",
    medium_italic: "ubuntu/Ubuntu-MI.ttf",
    bold_italic: "ubuntu/Ubuntu-BI.ttf"
  },
  dejavu: {
    normal: "dejavu/DejaVuSans.ttf",
    medium: "dejavu/DejaVuSans.ttf",
    bold: "dejavu/DejaVuSans-Bold.ttf",
    italic: "dejavu/DejaVuSans-Oblique.ttf",
    medium_italic: "dejavu/DejaVuSans-Oblique.ttf",
    bold_italic: "dejavu/DejaVuSans-BoldOblique.ttf"
  },
  liberation: {
    normal: "liberation/LiberationSans-Regular.ttf",
    medium: "liberation/LiberationSans-Regular.ttf",
    bold: "liberation/LiberationSans-Bold.ttf",
    italic: "liberation/LiberationSans-Italic.ttf",
    medium_italic: "liberation/LiberationSans-Italic.ttf",
    bold_italic: "liberation/LiberationSans-BoldItalic.ttf"
  },
  noto: {
    normal: "noto/NotoSans-Regular.ttf",
    medium: "noto/NotoSans-Medium.ttf",
    bold: "noto/NotoSans-Bold.ttf",
    italic: "noto/NotoSans-Italic.ttf",
    medium_italic: "noto/NotoSans-MediumItalic.ttf",
    bold_italic: "noto/NotoSans-BoldItalic.ttf"
  },
  nimbus: {
    normal: "nimbus/NimbusSans-Regular.ttf",
    medium: "nimbus/NimbusSans-Regular.ttf",
    bold: "nimbus/NimbusSans-Bold.ttf",
    italic: "nimbus/NimbusSans-Italic.ttf",
    medium_italic: "nimbus/NimbusSans-Italic.ttf",
    bold_italic: "nimbus/NimbusSans-Bold-Italic.ttf"
  },
  lato: {
    normal: "lato/Lato-Regular.ttf",
    medium: "lato/Lato-Medium.ttf",
    bold: "lato/Lato-Bold.ttf",
    italic: "lato/Lato-Italic.ttf",
    medium_italic: "lato/Lato-MediumItalic.ttf",
    bold_italic: "lato/Lato-BoldItalic.ttf"
  }
};

const FONT_SIZES = {
  xs: 24,
  sm: 32,
  md: 42,
  lg: 56,
  xl: 72
};

const FONT_COLORS = [
  "#FFFFFF", "#000000", "#FFEB3B", "#EF4444", "#3B82F6",
  "#22C55E", "#A855F7", "#F97316", "#06B6D4", "#EC4899", "#84CC16"
];

const BG_COLORS = [
  "#000000", "#FFFFFF", "#EF4444", "#3B82F6",
  "#22C55E", "#A855F7", "#F97316", "#06B6D4"
];

const FORMAT_DIMENSIONS = {
  "9:16": { width: 1080, height: 1920 },
  "16:9": { width: 1920, height: 1080 },
  "1:1": { width: 1080, height: 1080 },
  "4:5": { width: 1080, height: 1350 },
  "21:9": { width: 1920, height: 823 }
};

const FORMAT_MAX_CHARS = {
  "9:16": { default: 20, vertical: 20, horizontal: 25 },
  "16:9": { default: 45, vertical: 40, horizontal: 45 },
  "1:1": { default: 32, vertical: 30, horizontal: 35 },
  "4:5": { default: 35, vertical: 32, horizontal: 38 },
  "21:9": { default: 50, vertical: 45, horizontal: 50 }
};

const MIN_TAGLINE_FONT_SIZE = 18;
const MIN_TAGLINE_CHARS_PER_LINE = 8;
const ESTIMATED_CHAR_WIDTH_RATIO = 0.58;
const ESTIMATED_LINE_HEIGHT_RATIO = 1.18;
const ESTIMATED_LINE_SPACING_RATIO = 0.16;
const MAX_TAGLINE_LINES = 6;

function parseResolution(value) {
  const match = String(value || "").trim().match(/^(\d{3,5})x(\d{3,5})$/i);
  if (!match) return null;

  const width = parseInt(match[1], 10);
  const height = parseInt(match[2], 10);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }

  return { width, height };
}

let _hwaccelEncoder = null;
let _hwaccelChecked = false;

function detectHardwareEncoder() {
  if (_hwaccelChecked) return _hwaccelEncoder;
  _hwaccelChecked = true;

  // Linux (GitHub Actions runner) — no GPU drivers available, skip GPU encoders
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    _hwaccelEncoder = 'libx264';
    return _hwaccelEncoder;
  }

  try {
    const output = execSync(`${FFMPEG} -hide_banner -encoders 2>&1`, { encoding: 'utf8', timeout: 15000 });
    if (output.includes('h264_amf')) {
      try {
        execSync(`${FFMPEG} -f lavfi -i color=c=black:d=1 -frames:v 1 -c:v h264_amf -f null - 2>&1`, { encoding: 'utf8', timeout: 10000 });
        _hwaccelEncoder = 'h264_amf'; return _hwaccelEncoder;
      } catch {}
    }
    if (output.includes('h264_nvenc')) {
      try {
        execSync(`${FFMPEG} -f lavfi -i color=c=black:d=1 -frames:v 1 -c:v h264_nvenc -f null - 2>&1`, { encoding: 'utf8', timeout: 10000 });
        _hwaccelEncoder = 'h264_nvenc'; return _hwaccelEncoder;
      } catch {}
    }
    if (output.includes('h264_videotoolbox')) {
      try {
        execSync(`${FFMPEG} -f lavfi -i color=c=black:d=1 -frames:v 1 -c:v h264_videotoolbox -f null - 2>&1`, { encoding: 'utf8', timeout: 10000 });
        _hwaccelEncoder = 'h264_videotoolbox'; return _hwaccelEncoder;
      } catch {}
    }
    if (output.includes('h264_qsv')) {
      try {
        execSync(`${FFMPEG} -f lavfi -i color=c=black:d=1 -frames:v 1 -c:v h264_qsv -f null - 2>&1`, { encoding: 'utf8', timeout: 10000 });
        _hwaccelEncoder = 'h264_qsv'; return _hwaccelEncoder;
      } catch {}
    }
  } catch {}
  _hwaccelEncoder = 'libx264';
  return _hwaccelEncoder;
}

function getCPUPreset() {
  const cores = os.cpus().length;
  // 8+ cores = powerful runner → ultrafast for 3-4x faster encoding
  return cores >= 8 ? 'ultrafast' : 'veryfast';
}

function getOutputEncodeArgs(config, options = {}) {
  const quality = String(config.output_quality || "high");
  const cpuPreset = getCPUPreset();
  const presets = {
    low: { preset: cpuPreset, crf: 30 },
    medium: { preset: cpuPreset, crf: 27 },
    high: { preset: cpuPreset, crf: 24 }
  };
  const profile = presets[quality] || presets.high;
  const audioArgs = options.disableAudio ? "-an" : "-c:a aac -b:a 96k";
  const encoder = detectHardwareEncoder();
  const ytFlags = '-profile:v high -level:v 4.1 -g 48';
  if (encoder === 'libx264') {
    return `-c:v libx264 ${ytFlags} -preset ${profile.preset} -crf ${profile.crf} ${audioArgs} -pix_fmt yuv420p`;
  }
  if (encoder === 'h264_amf') {
    return `-c:v h264_amf ${ytFlags} -quality speed -usage transcoding ${audioArgs}`;
  }
  if (encoder === 'h264_nvenc') {
    return `-c:v h264_nvenc ${ytFlags} -preset p1 -cq ${profile.crf} ${audioArgs}`;
  }
  if (encoder === 'h264_videotoolbox') {
    return `-c:v h264_videotoolbox ${ytFlags} -quality speed -allow_sw 1 ${audioArgs}`;
  }
  if (encoder === 'h264_qsv') {
    return `-c:v h264_qsv ${ytFlags} -preset veryfast -global_quality ${profile.crf} ${audioArgs}`;
  }
  return `-c:v libx264 ${ytFlags} -preset ${profile.preset} -crf ${profile.crf} ${audioArgs} -pix_fmt yuv420p`;
}

function escapeDrawtextValue(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "'\\''")
    .replace(/:/g, "\\:");
}

let _textFileCounter = 0;
function writeDrawtextFile(text) {
  const dir = process.env.OUTPUT_DIR
    ? path.resolve(process.env.OUTPUT_DIR)
    : path.join(process.cwd(), "output");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `_tagline_${++_textFileCounter}.txt`);
  const content = String(text || "").replace(/\\n/g, "\n");
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

function escapeFilterPath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/'/g, "\\'")
    .replace(/:/g, "\\:");
}

function findExistingFont(candidates) {
  for (const candidate of candidates) {
    const fontPath = path.join(FONT_DIR, candidate);
    if (fs.existsSync(fontPath)) {
      return fontPath;
    }
  }

  return null;
}

function getFontFile(fontFamily, fontStyle) {
  if (process.platform === "win32") {
    const family = WINDOWS_FONT_MAP[fontFamily] || WINDOWS_FONT_MAP.ubuntu;
    const candidates = family[fontStyle] || family.bold;
    const resolved = findExistingFont(candidates);
    if (resolved) {
      return resolved;
    }

    return findExistingFont(WINDOWS_FONT_MAP.ubuntu.bold) || null;
  }

  const family = FONT_MAP[fontFamily] || FONT_MAP.ubuntu;
  const styleMap = {
    normal: family.normal,
    bold: family.bold,
    italic: family.italic,
    bold_italic: family.bold_italic,
    medium: family.medium,
    medium_italic: family.medium_italic
  };
  return path.join(FONT_DIR, styleMap[fontStyle] || family.bold);
}

function getFormatDimensions(format, outputDimensions) {
  const width = Number(outputDimensions?.width);
  const height = Number(outputDimensions?.height);

  if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
    return { width, height };
  }

  return FORMAT_DIMENSIONS[format] || FORMAT_DIMENSIONS["9:16"];
}

function normalizeTaglineText(text) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function wrapText(text, maxCharsPerLine, format) {
  const normalized = normalizeTaglineText(text);
  const formatChars = FORMAT_MAX_CHARS[format] || FORMAT_MAX_CHARS["9:16"];
  const maxChars = Math.max(MIN_TAGLINE_CHARS_PER_LINE, maxCharsPerLine || formatChars.default);

  if (!normalized) {
    return "";
  }

  const paragraphs = normalized.split("\n");
  const lines = [];

  for (const paragraph of paragraphs) {
    if (paragraph.length <= maxChars) {
      lines.push(paragraph);
      continue;
    }

    const words = paragraph.split(" ");
    let currentLine = "";

    for (const word of words) {
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      if (testLine.length <= maxChars) {
        currentLine = testLine;
      } else {
        if (currentLine) lines.push(currentLine);
        if (word.length > maxChars) {
          let remaining = word;
          while (remaining.length > maxChars) {
            lines.push(remaining.substring(0, maxChars));
            remaining = remaining.substring(maxChars);
          }
          currentLine = remaining;
        } else {
          currentLine = word;
        }
      }
    }

    if (currentLine) {
      lines.push(currentLine);
    }
  }

  return lines.join("\\n");
}

function estimateTaglineBlock(text, fontSize, lineSpacing) {
  const lines = String(text || "").split("\\n").filter(Boolean);
  const longestLine = lines.reduce((max, line) => Math.max(max, line.length), 0);

  return {
    lineCount: Math.max(lines.length, 1),
    estimatedWidth: Math.ceil(longestLine * fontSize * ESTIMATED_CHAR_WIDTH_RATIO),
    estimatedHeight: Math.ceil(
      Math.max(lines.length, 1) * fontSize * ESTIMATED_LINE_HEIGHT_RATIO +
      Math.max(lines.length - 1, 0) * lineSpacing
    )
  };
}

function fitTaglineText(tagline, options) {
  const normalized = normalizeTaglineText(tagline);
  if (!normalized) {
    return {
      text: "",
      fontSize: options.baseFontSize,
      lineSpacing: Math.max(4, Math.round(options.baseFontSize * ESTIMATED_LINE_SPACING_RATIO))
    };
  }

  const { width, height } = getFormatDimensions(options.format, options.outputDimensions);
  const horizontalPadding = Math.max(48, Math.round(width * 0.08));
  const availableWidth = Math.max(240, width - horizontalPadding * 2);
  const maxVerticalSpace = Math.max(
    Math.round(height * (height > width ? 0.28 : 0.2)),
    Math.round(options.baseFontSize * 1.8)
  );
  const availableHeight = Math.max(
    Math.round(options.baseFontSize * 1.8),
    Math.min(maxVerticalSpace, height - options.topMargin - options.bottomMargin - 40)
  );
  const preferredChars = options.wrapMaxChars > 0
    ? options.wrapMaxChars
    : options.softCharLimit > 0
    ? options.softCharLimit
    : 0;

  let currentFontSize = options.baseFontSize;

  while (currentFontSize >= MIN_TAGLINE_FONT_SIZE) {
    const autoMaxChars = Math.max(
      MIN_TAGLINE_CHARS_PER_LINE,
      Math.floor(availableWidth / (currentFontSize * ESTIMATED_CHAR_WIDTH_RATIO))
    );
    const maxChars = preferredChars > 0 ? Math.min(preferredChars, autoMaxChars) : autoMaxChars;
    const wrappedText = wrapText(normalized, maxChars, options.format);
    const lineSpacing = Math.max(4, Math.round(currentFontSize * ESTIMATED_LINE_SPACING_RATIO));
    const metrics = estimateTaglineBlock(wrappedText, currentFontSize, lineSpacing);
    const bgPadding = options.hasBoxBackground ? 24 : 0;

    if (metrics.estimatedWidth <= availableWidth && metrics.estimatedHeight + bgPadding <= availableHeight) {
      const maxLines = Math.min(MAX_TAGLINE_LINES, Math.max(2, Math.floor((availableHeight - bgPadding) / (currentFontSize * ESTIMATED_LINE_HEIGHT_RATIO + lineSpacing))));

      if (metrics.lineCount > maxLines) {
        const lines = wrappedText.split("\\n");
        const truncatedLines = lines.slice(0, maxLines);
        const lastLine = truncatedLines[truncatedLines.length - 1];
        if (lastLine.length > 3) {
          truncatedLines[truncatedLines.length - 1] = lastLine.substring(0, lastLine.length - 3) + "...";
        } else {
          truncatedLines[truncatedLines.length - 1] = "...";
        }
        const truncatedText = truncatedLines.join("\\n");
        const truncatedMetrics = estimateTaglineBlock(truncatedText, currentFontSize, lineSpacing);

        return {
          text: truncatedText,
          fontSize: currentFontSize,
          lineSpacing,
          lineCount: truncatedMetrics.lineCount,
          estimatedWidth: truncatedMetrics.estimatedWidth,
          estimatedHeight: truncatedMetrics.estimatedHeight
        };
      }

      return {
        text: wrappedText,
        fontSize: currentFontSize,
        lineSpacing,
        lineCount: metrics.lineCount,
        estimatedWidth: metrics.estimatedWidth,
        estimatedHeight: metrics.estimatedHeight
      };
    }

    currentFontSize -= 2;
  }

  const fallbackFontSize = MIN_TAGLINE_FONT_SIZE;
  const fallbackMaxChars = Math.max(
    MIN_TAGLINE_CHARS_PER_LINE,
    Math.floor(availableWidth / (fallbackFontSize * ESTIMATED_CHAR_WIDTH_RATIO))
  );
  const resolvedMaxChars = preferredChars > 0 ? Math.min(preferredChars, fallbackMaxChars) : fallbackMaxChars;
  const wrappedText = wrapText(normalized, resolvedMaxChars, options.format);
  const lineSpacing = Math.max(4, Math.round(fallbackFontSize * ESTIMATED_LINE_SPACING_RATIO));
  const metrics = estimateTaglineBlock(wrappedText, fallbackFontSize, lineSpacing);
  const bgPadding = options.hasBoxBackground ? 24 : 0;

  const maxLines = Math.min(MAX_TAGLINE_LINES, Math.max(2, Math.floor((availableHeight - bgPadding) / (fallbackFontSize * ESTIMATED_LINE_HEIGHT_RATIO + lineSpacing))));

  if (metrics.lineCount > maxLines) {
    const lines = wrappedText.split("\\n");
    const truncatedLines = lines.slice(0, maxLines);
    const lastLine = truncatedLines[truncatedLines.length - 1];
    if (lastLine.length > 3) {
      truncatedLines[truncatedLines.length - 1] = lastLine.substring(0, lastLine.length - 3) + "...";
    } else {
      truncatedLines[truncatedLines.length - 1] = "...";
    }
    const truncatedText = truncatedLines.join("\\n");
    const truncatedMetrics = estimateTaglineBlock(truncatedText, fallbackFontSize, lineSpacing);

    return {
      text: truncatedText,
      fontSize: fallbackFontSize,
      lineSpacing,
      lineCount: truncatedMetrics.lineCount,
      estimatedWidth: truncatedMetrics.estimatedWidth,
      estimatedHeight: truncatedMetrics.estimatedHeight
    };
  }

  return {
    text: wrappedText,
    fontSize: fallbackFontSize,
    lineSpacing,
    lineCount: metrics.lineCount,
    estimatedWidth: metrics.estimatedWidth,
    estimatedHeight: metrics.estimatedHeight
  };
}

function getRandomItem(array) {
  return array[Math.floor(Math.random() * array.length)];
}

function checkFontsExist() {
  const fontPath = getFontFile("ubuntu", "bold");
  try {
    return !!fontPath && fs.existsSync(fontPath);
  } catch (e) {
    return false;
  }
}

const FONTS_AVAILABLE = checkFontsExist();
console.log("Fonts available:", FONTS_AVAILABLE);

function buildTaglineDrawtext(tagline, config, position, format, outputDimensions) {
  if (!tagline) return null;

  if (!FONTS_AVAILABLE) {
    console.log("Skipping tagline - fonts not available on this system");
    return null;
  }

  const fontFamily = config.tagline_font_family || "ubuntu";
  const fontStyle = config.tagline_font_style || "bold";
  const fontSize = config.tagline_font_size || "md";
  const fontColor = config.tagline_random_font_color
    ? getRandomItem(FONT_COLORS)
    : (config.tagline_font_color || "#FFFFFF");
  const bgType = config.tagline_background_type || "none";
  const bgColor = config.tagline_random_background
    ? getRandomItem(BG_COLORS)
    : (config.tagline_background_color || "#000000");
  const bgOpacity = (config.tagline_background_opacity ?? 100) / 100;
  const charLimit = config.tagline_char_limit ?? 0;
  const wrapEnabled = config.tagline_wrap_enabled !== false;
  const wrapMaxChars = config.tagline_wrap_max_chars ?? 0;

  const topMargin = parseInt(String(config.tagline_top_margin ?? "80"), 10);
  const bottomMargin = parseInt(String(config.tagline_bottom_margin ?? "80"), 10);

  const fontPath = getFontFile(fontFamily, fontStyle);
  if (!fontPath) {
    console.log("Skipping tagline - no compatible font found");
    return null;
  }
  const baseFontSize = FONT_SIZES[fontSize] || FONT_SIZES.md;
  const layout = fitTaglineText(tagline, {
    format,
    outputDimensions,
    baseFontSize,
    wrapMaxChars: wrapEnabled ? wrapMaxChars : 0,
    softCharLimit: charLimit,
    topMargin,
    bottomMargin,
    hasBoxBackground: bgType === "box" || bgType === "rounded_box"
  });

  if (!layout.text) {
    return null;
  }

  const textFilePath = writeDrawtextFile(layout.text);
  const escapedTextFilePath = escapeFilterPath(textFilePath);
  const escapedFontPath = escapeFilterPath(fontPath);

  let filter = `drawtext=textfile='${escapedTextFilePath}':fontfile='${escapedFontPath}':fontsize=${layout.fontSize}:fontcolor=${fontColor}:line_spacing=${layout.lineSpacing}:fix_bounds=1`;

  if (bgType === "box" || bgType === "rounded_box") {
    filter += `:box=1:boxcolor=${bgColor}@${bgOpacity}:boxborderw=10`;
  }

  filter += `:borderw=2:bordercolor=black@0.5`;

  if (position === "top") {
    filter += `:x=(w-text_w)/2:y=${topMargin}`;
  } else {
    filter += `:x=(w-text_w)/2:y=h-text_h-${bottomMargin}`;
  }

  console.log(
    `Tagline layout (${position}): ${layout.lineCount || 1} line(s), ` +
    `font ${layout.fontSize}px, approx ${layout.estimatedWidth || 0}x${layout.estimatedHeight || 0}`
  );
  console.log(`Tagline filter: ${filter}`);
  return filter;
}

function buildOverlayDrawtext(text, config, options) {
  if (!text || !FONTS_AVAILABLE) {
    return null;
  }

  const fontFamily = config.tagline_font_family || "ubuntu";
  const fontStyle = options.fontStyle || config.tagline_font_style || "bold";
  const fontPath = getFontFile(fontFamily, fontStyle);
  if (!fontPath) {
    return null;
  }
  const textFilePath = writeDrawtextFile(text);
  const escapedTextFilePath = escapeFilterPath(textFilePath);
  const escapedFontPath = escapeFilterPath(fontPath);
  const fontSize = options.fontSize || 24;
  const fontColor = options.fontColor || "#FFFFFF";
  const borderWidth = options.borderWidth || 2;
  const borderColor = options.borderColor || "black@0.45";

  return `drawtext=textfile='${escapedTextFilePath}':fontfile='${escapedFontPath}':fontsize=${fontSize}:fontcolor=${fontColor}:x=${options.x}:y=${options.y}:borderw=${borderWidth}:bordercolor=${borderColor}`;
}

function getVideoDuration(inputFile) {
  try {
    const output = execSync(`${FFPROBE} -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${inputFile}"`, { encoding: "utf8" });
    return parseFloat(output.trim());
  } catch (e) {
    return null;
  }
}

function hasAudioTrack(inputFile) {
  try {
    const output = execSync(`${FFPROBE} -v error -select_streams a -show_entries stream=codec_name "${inputFile}"`, { encoding: "utf8" });
    return output.includes("codec_name");
  } catch (e) {
    return false;
  }
}

function remuxWithFaststart(inputFile, outputFile, codecArgs) {
  // Try with given codec args first (may include HW encoder)
  const cmd = `${FFMPEG} -hwaccel auto -y -i "${inputFile}" ${codecArgs} -movflags +faststart "${outputFile}"`;
  console.log("Finalize CMD:", cmd);
  try {
    execSync(cmd, { stdio: "inherit", timeout: 300000 });
  } catch (e) {
    // If HW encoder failed, retry with libx264 CPU fallback
    console.log("[PROCESS] HW encoder failed, retrying with libx264...");
    const fallbackCmd = `${FFMPEG} -y -i "${inputFile}" -c:v libx264 -profile:v high -level:v 4.1 -g 48 -preset veryfast -crf 24 -c:a aac -b:a 96k -pix_fmt yuv420p -movflags +faststart "${outputFile}"`;
    console.log("Fallback CMD:", fallbackCmd);
    execSync(fallbackCmd, { stdio: "inherit", timeout: 600000 });
  }
}

/**
 * ============================================================================
 * Multi-Overlay System (image / video / logo overlays)
 * ============================================================================
 * Applies an array of image/video/logo overlays in a dedicated FFmpeg pass
 * (run AFTER the main scale/crop+drawtext pass, BEFORE audio muting).
 *
 * Each overlay (config.overlays[i]):
 *   url, start_seconds, duration_seconds | full_video, position, scale_percent,
 *   animation (none|rotation|move|fade), rotation_period_sec, move_direction,
 *   fade_seconds, opacity
 *
 * Assets are referenced by URL and downloaded via curl to local temp files
 * (FFmpeg overlay inputs must be local files). Per-overlay failures are
 * isolated — a bad overlay is skipped, the job still completes.
 * ============================================================================
 */

const OVERLAY_MARGIN = 30;
const MAX_OVERLAYS = 10;

// Raw (unquoted) resolved binaries for arg-array spawnSync calls.
const FFMPEG_BIN = resolveCommand("ffmpeg");
const CURL_BIN = resolveCommand("curl");

function detectOverlayKind(fileOrUrl) {
  const ext = String(fileOrUrl || "").toLowerCase().replace(/[?#].*$/, "").match(/\.([a-z0-9]+)$/);
  const e = ext ? ext[1] : "";
  if (e === "gif") return "gif";
  if (["png", "jpg", "jpeg", "webp", "bmp"].includes(e)) return "image";
  if (["mp4", "mov", "webm", "mkv", "m4v", "avi"].includes(e)) return "video";
  // Default unknown extensions to image (safest: single decoded frame, looped).
  return "image";
}

function overlayExtForKind(url, kind) {
  const m = String(url || "").toLowerCase().replace(/[?#].*$/, "").match(/\.([a-z0-9]+)$/);
  if (m) return m[1];
  return kind === "video" ? "mp4" : kind === "gif" ? "gif" : "png";
}

function downloadOverlayAsset(url, destPath) {
  const args = [
    "-L", "--fail",
    "--connect-timeout", "10",
    "--max-time", "60",
    "-o", destPath,
    url,
  ];
  try {
    if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
  } catch {}
  const result = spawnSync(CURL_BIN, args, { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8", timeout: 90000 });
  if (result.error) {
    throw new Error(`curl failed: ${result.error.message}`);
  }
  if (typeof result.status === "number" && result.status !== 0) {
    const tail = String(result.stderr || "").trim().split("\n").slice(-2).join(" | ");
    throw new Error(`curl exited ${result.status}${tail ? `: ${tail}` : ""}`);
  }
  if (!fs.existsSync(destPath) || fs.statSync(destPath).size <= 0) {
    throw new Error("downloaded overlay asset is empty");
  }
  return destPath;
}

function buildOverlayInputArgs(kind, fullVideo, filePath) {
  if (kind === "image") {
    return ["-loop", "1", "-i", filePath];
  }
  if (kind === "gif") {
    return ["-ignore_loop", "0", "-i", filePath];
  }
  // video
  if (fullVideo) {
    return ["-stream_loop", "-1", "-i", filePath];
  }
  return ["-i", filePath];
}

function getOverlayPositionExpr(position, margin) {
  const m = margin;
  switch (String(position || "bottom-right")) {
    case "center": return { x: "(W-w)/2", y: "(H-h)/2" };
    case "top": return { x: "(W-w)/2", y: `${m}` };
    case "bottom": return { x: "(W-w)/2", y: `H-h-${m}` };
    case "left": return { x: `${m}`, y: "(H-h)/2" };
    case "right": return { x: `W-w-${m}`, y: "(H-h)/2" };
    case "top-left": return { x: `${m}`, y: `${m}` };
    case "top-right": return { x: `W-w-${m}`, y: `${m}` };
    case "bottom-left": return { x: `${m}`, y: `H-h-${m}` };
    case "bottom-right": return { x: `W-w-${m}`, y: `H-h-${m}` };
    default: return { x: `W-w-${m}`, y: `H-h-${m}` };
  }
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Build the prep sub-chain for one overlay and its overlay= placement params.
 * Returns { prep, x, y, enable } or null when the overlay should be skipped.
 */
function buildSingleOverlayChain(overlay, inputIndex, width, height, baseDuration) {
  const start = Math.max(0, num(overlay.start_seconds, 0));
  if (baseDuration && start >= baseDuration) {
    return null; // starts after the video ends
  }
  const fullVideo = overlay.full_video === true || overlay.full_video === "true";
  const dur = fullVideo
    ? (baseDuration || 0) - start
    : Math.max(0.1, num(overlay.duration_seconds, 5));
  const end = baseDuration ? Math.min(start + dur, baseDuration) : start + dur;
  const effDur = Math.max(0.1, end - start);

  const position = String(overlay.position || "bottom-right");
  const animation = String(overlay.animation || "none");
  const opacity = Math.max(0, Math.min(100, num(overlay.opacity, 100))) / 100;
  const scalePercent = Math.max(1, num(overlay.scale_percent, 20));

  const filters = ["format=rgba"];

  // Scale (precomputed pixel size — overlay's own scale can't reference main_w).
  if (position === "full_cover") {
    filters.push(`scale=${width}:${height}`);
  } else {
    const targetW = Math.max(2, Math.round(width * (scalePercent / 100)));
    filters.push(`scale=${targetW}:-2`);
  }

  // Align overlay clock to the main timeline so t-based exprs use absolute seconds.
  filters.push(start > 0 ? `setpts=PTS-STARTPTS+${start}/TB` : "setpts=PTS-STARTPTS");

  // Rotation (continuous spin). Escape commas inside hypot() for the filtergraph parser.
  if (animation === "rotation") {
    const period = Math.max(0.2, num(overlay.rotation_period_sec, 4));
    filters.push(`rotate=2*PI*(t-${start})/${period}:c=none:ow=hypot(iw\\,ih):oh=hypot(iw\\,ih)`);
  }

  // Opacity (constant alpha multiplier) applied before fade.
  if (opacity < 1) {
    filters.push(`colorchannelmixer=aa=${opacity.toFixed(3)}`);
  }

  // Fade in + out (alpha) within the active window.
  if (animation === "fade") {
    const fade = Math.max(0.1, Math.min(num(overlay.fade_seconds, 1), effDur / 2));
    filters.push(`fade=t=in:st=${start}:d=${fade}:alpha=1`);
    filters.push(`fade=t=out:st=${(end - fade).toFixed(3)}:d=${fade}:alpha=1`);
  }

  const label = `ov${inputIndex}`;
  const prep = `[${inputIndex}:v]${filters.join(",")}[${label}]`;

  // Position / movement.
  let x;
  let y;
  if (position === "full_cover") {
    x = "0";
    y = "0";
  } else {
    const pos = getOverlayPositionExpr(position, OVERLAY_MARGIN);
    x = pos.x;
    y = pos.y;
    if (animation === "move") {
      const dir = String(overlay.move_direction || "left_right");
      if (dir === "left_right") x = `-w+(W+w)*(t-${start})/${effDur.toFixed(3)}`;
      else if (dir === "right_left") x = `W-(W+w)*(t-${start})/${effDur.toFixed(3)}`;
      else if (dir === "top_bottom") y = `-h+(H+h)*(t-${start})/${effDur.toFixed(3)}`;
      else if (dir === "bottom_top") y = `H-(H+h)*(t-${start})/${effDur.toFixed(3)}`;
    }
  }

  // full_video overlays don't need a timing gate; others use between(t,start,end).
  const enable = fullVideo ? null : `between(t,${start},${end.toFixed(3)})`;

  return { prep, label, x, y, enable };
}

/**
 * Assemble the complete filter_complex graph + per-overlay input args.
 * Returns { filterComplex, inputArgs } or null when nothing usable.
 */
function buildOverlayFilterComplex(validOverlays, width, height, baseDuration) {
  const preps = [];
  const inputArgs = [];
  const placements = [];

  validOverlays.forEach((entry, i) => {
    const inputIndex = i + 1; // input 0 is the base video
    const chain = buildSingleOverlayChain(entry.overlay, inputIndex, width, height, baseDuration);
    if (!chain) {
      console.log(`[OVERLAY] skipping #${entry.originalIndex} — outside video timeline`);
      return;
    }
    inputArgs.push(...buildOverlayInputArgs(entry.kind, entry.fullVideo, entry.filePath));
    preps.push(chain.prep);
    placements.push(chain);
  });

  if (placements.length === 0) {
    return null;
  }

  const steps = [];
  let current = "[0:v]";
  placements.forEach((p, idx) => {
    const outLabel = idx === placements.length - 1 ? "[vout]" : `[t${idx}]`;
    const enablePart = p.enable ? `:enable='${p.enable}'` : "";
    steps.push(`${current}[${p.label}]overlay=x=${p.x}:y=${p.y}${enablePart}:eof_action=pass${outLabel}`);
    current = outLabel;
  });

  const filterComplex = [...preps, ...steps].join(";");
  return { filterComplex, inputArgs };
}

function runOverlayFfmpeg(inFile, outFile, inputArgs, filterComplex, config) {
  const encodeArgs = getOutputEncodeArgs(config).split(/\s+/).filter(Boolean);
  const baseArgs = [
    "-y",
    "-i", inFile,
    ...inputArgs,
    "-filter_complex", filterComplex,
    "-map", "[vout]",
    "-map", "0:a?",
    ...encodeArgs,
    "-movflags", "+faststart",
    "-shortest",
    outFile,
  ];
  console.log("[OVERLAY] FFmpeg filter_complex:", filterComplex);
  let result = spawnSync(FFMPEG_BIN, baseArgs, { stdio: "inherit", timeout: 600000 });
  if (!result.error && result.status === 0 && fs.existsSync(outFile)) {
    return true;
  }
  // Fallback: force libx264 CPU encode (HW encoder may reject the rgba graph).
  console.log("[OVERLAY] HW/primary encode failed, retrying with libx264...");
  const fallbackArgs = [
    "-y",
    "-i", inFile,
    ...inputArgs,
    "-filter_complex", filterComplex,
    "-map", "[vout]",
    "-map", "0:a?",
    "-c:v", "libx264", "-profile:v", "high", "-level:v", "4.1", "-g", "48",
    "-preset", "veryfast", "-crf", "24",
    "-c:a", "aac", "-b:a", "96k", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    "-shortest",
    outFile,
  ];
  result = spawnSync(FFMPEG_BIN, fallbackArgs, { stdio: "inherit", timeout: 900000 });
  return !result.error && result.status === 0 && fs.existsSync(outFile);
}

/**
 * Orchestrator: download assets, build graph, run overlay pass.
 * Returns true if outFile was produced; false to fall back to the un-overlaid input.
 */
function applyOverlays(inFile, outFile, overlays, config, width, height) {
  console.log("=== APPLY OVERLAYS ===");
  const list = Array.isArray(overlays) ? overlays.slice(0, MAX_OVERLAYS) : [];
  if (list.length === 0) {
    return false;
  }

  const baseDuration = getVideoDuration(inFile) || 0;
  console.log(`[OVERLAY] base duration: ${baseDuration}s, overlays requested: ${list.length}`);

  const downloaded = [];
  const validOverlays = [];

  try {
    list.forEach((overlay, i) => {
      const url = String(overlay && overlay.url || "").trim();
      if (!url) {
        console.log(`[OVERLAY] skipping #${i} — no url`);
        return;
      }
      const kind = detectOverlayKind(url);
      const fullVideo = overlay.full_video === true || overlay.full_video === "true";
      const destPath = path.join(OUTPUT_DIR, `overlay_${i}.${overlayExtForKind(url, kind)}`);
      try {
        downloadOverlayAsset(url, destPath);
        downloaded.push(destPath);
        validOverlays.push({ overlay, kind, fullVideo, filePath: destPath, originalIndex: i });
        console.log(`[OVERLAY] #${i} downloaded (${kind}): ${url}`);
      } catch (err) {
        console.log(`[OVERLAY] skipping #${i} — download failed: ${err.message}`);
      }
    });

    if (validOverlays.length === 0) {
      console.log("[OVERLAY] no usable overlays, skipping overlay pass");
      return false;
    }

    const graph = buildOverlayFilterComplex(validOverlays, width, height, baseDuration);
    if (!graph) {
      console.log("[OVERLAY] no valid overlay placements, skipping overlay pass");
      return false;
    }

    const ok = runOverlayFfmpeg(inFile, outFile, graph.inputArgs, graph.filterComplex, config);
    if (ok) {
      console.log("✅ Overlays applied successfully!");
      return true;
    }
    console.log("[OVERLAY] overlay pass failed, falling back to un-overlaid video");
    return false;
  } catch (err) {
    console.error("[OVERLAY] Unexpected error:", err.message);
    return false;
  } finally {
    for (const file of downloaded) {
      try { fs.unlinkSync(file); } catch {}
    }
  }
}

/**
 * ============================================================================
 * Multi-Track Audio System (Audio tab)
 * ============================================================================
 * Applies an array of audio tracks in a dedicated audio-only FFmpeg pass
 * (run AFTER the mute pass — mute only affects the original audio, user-added
 * tracks are layered on top and can't be silenced by mute).
 *
 * Each track (config.audio_tracks[i]):
 *   url, use_full_audio, source_start, source_end, loop,
 *   placement (whole|first|last|custom), placement_seconds,
 *   placement_start, placement_end, mode (replace|mix),
 *   audio_volume (0-200 %), original_volume (0-100 %, mix only),
 *   fade_in, fade_out (seconds)
 *
 * Video stream is stream-copied (-c:v copy) — only audio is re-encoded.
 * Per-track failures are isolated — a bad track is skipped, job continues.
 * ============================================================================
 */

const MAX_AUDIO_TRACKS = 5;

function audioExtFromUrl(url) {
  const m = String(url || "").toLowerCase().replace(/[?#].*$/, "").match(/\.([a-z0-9]+)$/);
  if (m && ["mp3", "wav", "m4a", "aac", "ogg", "flac", "opus", "wma", "mp4"].includes(m[1])) {
    return m[1];
  }
  return "mp3";
}

/**
 * Resolve where on the video timeline a track applies.
 * Returns { start, end } in seconds, or null when invalid/outside video.
 */
function resolveAudioPlacement(track, videoDuration) {
  const p = String(track.placement || "whole");
  if (p === "first") {
    const n = Math.min(Math.max(0.1, num(track.placement_seconds, 10)), videoDuration);
    return { start: 0, end: n };
  }
  if (p === "last") {
    const n = Math.min(Math.max(0.1, num(track.placement_seconds, 10)), videoDuration);
    return { start: videoDuration - n, end: videoDuration };
  }
  if (p === "custom") {
    const s = Math.max(0, num(track.placement_start, 0));
    const e = Math.min(num(track.placement_end, videoDuration), videoDuration);
    if (e <= s || s >= videoDuration) return null;
    return { start: s, end: e };
  }
  return { start: 0, end: videoDuration }; // whole
}

/**
 * Build the filter sub-chain for one audio track input.
 * Returns the prep string ("[N:a]...[trkN]").
 */
function buildAudioTrackChain(track, inputIndex, placement, audioDuration) {
  const sectionLen = placement.end - placement.start;
  const filters = [];

  // Source clip selection (audio ke andar se range)
  const useFull = track.use_full_audio !== false;
  if (!useFull) {
    let srcStart = Math.max(0, num(track.source_start, 0));
    let srcEnd = num(track.source_end, 0);
    if (audioDuration && srcStart >= audioDuration) {
      srcStart = 0; // invalid start — fall back to full audio
      srcEnd = 0;
    }
    if (srcEnd > srcStart) {
      filters.push(`atrim=start=${srcStart}:end=${srcEnd}`);
    } else if (srcStart > 0) {
      filters.push(`atrim=start=${srcStart}`);
    }
    if (filters.length > 0) {
      filters.push("asetpts=PTS-STARTPTS");
    }
  }

  // Loop the (trimmed) clip to fill the placement window
  if (track.loop === true || track.loop === "true") {
    filters.push("aloop=loop=-1:size=2e9");
  }

  // Always cap to the section length (caps loops and too-long clips)
  filters.push(`atrim=0:${sectionLen.toFixed(3)}`, "asetpts=PTS-STARTPTS");

  // Volume (0-200 %)
  const vol = Math.max(0, Math.min(200, num(track.audio_volume, 100))) / 100;
  if (vol !== 1) {
    filters.push(`volume=${vol.toFixed(3)}`);
  }

  // Fades (clamped to half the section each)
  const fadeIn = Math.max(0, Math.min(num(track.fade_in, 0), sectionLen / 2));
  const fadeOut = Math.max(0, Math.min(num(track.fade_out, 0), sectionLen / 2));
  if (fadeIn > 0) {
    filters.push(`afade=t=in:st=0:d=${fadeIn}`);
  }
  if (fadeOut > 0) {
    filters.push(`afade=t=out:st=${(sectionLen - fadeOut).toFixed(3)}:d=${fadeOut}`);
  }

  // Shift to the placement start on the video timeline
  const delayMs = Math.round(placement.start * 1000);
  if (delayMs > 0) {
    filters.push(`adelay=${delayMs}|${delayMs}`);
  }

  return `[${inputIndex}:a]${filters.join(",")}[trk${inputIndex}]`;
}

/**
 * Orchestrator: download audio assets, build filter graph, run audio-only pass.
 * Returns true if outFile was produced; false to keep the previous output.
 */
function applyAudioTracks(inFile, outFile, audioTracks, config) {
  console.log("=== APPLY AUDIO TRACKS ===");
  const list = Array.isArray(audioTracks) ? audioTracks.slice(0, MAX_AUDIO_TRACKS) : [];
  if (list.length === 0) {
    return false;
  }

  const videoDuration = getVideoDuration(inFile) || 0;
  if (!videoDuration) {
    console.log("[AUDIO] could not determine video duration, skipping audio tracks");
    return false;
  }
  console.log(`[AUDIO] video duration: ${videoDuration}s, tracks requested: ${list.length}`);

  const downloaded = [];

  try {
    // Download + validate each track
    const validTracks = [];
    list.forEach((track, i) => {
      const url = String(track && track.url || "").trim();
      if (!url) {
        console.log(`[AUDIO] skipping #${i} — no url`);
        return;
      }
      const placement = resolveAudioPlacement(track, videoDuration);
      if (!placement) {
        console.log(`[AUDIO] skipping #${i} — invalid placement (outside video timeline)`);
        return;
      }
      const destPath = path.join(OUTPUT_DIR, `audiotrack_${i}.${audioExtFromUrl(url)}`);
      try {
        downloadOverlayAsset(url, destPath);
        downloaded.push(destPath);
        const audioDuration = getVideoDuration(destPath) || 0;
        validTracks.push({ track, placement, filePath: destPath, audioDuration, originalIndex: i });
        console.log(`[AUDIO] #${i} downloaded (${audioDuration ? audioDuration.toFixed(1) + "s" : "unknown duration"}): ${url}`);
      } catch (err) {
        console.log(`[AUDIO] skipping #${i} — download failed: ${err.message}`);
      }
    });

    if (validTracks.length === 0) {
      console.log("[AUDIO] no usable audio tracks, skipping audio pass");
      return false;
    }

    // Base audio chain: original audio, or silence when the video has none
    const hasAudio = hasAudioTrack(inFile);
    const preps = [];
    const inputArgs = [];
    let nextInputIndex = 1; // input 0 is the video

    let baseLabel;
    if (hasAudio) {
      baseLabel = "0:a";
    } else {
      inputArgs.push("-f", "lavfi", "-t", String(videoDuration), "-i", "anullsrc=channel_layout=stereo:sample_rate=44100");
      baseLabel = `${nextInputIndex}:a`;
      nextInputIndex += 1;
    }

    // Replace-mode windows silence the base; mix-mode windows duck it
    const baseFilters = [];
    validTracks.forEach(({ track, placement }) => {
      const start = placement.start.toFixed(3);
      const end = placement.end.toFixed(3);
      if (String(track.mode || "replace") === "replace") {
        baseFilters.push(`volume=enable='between(t,${start},${end})':volume=0`);
      } else {
        const ov = Math.max(0, Math.min(100, num(track.original_volume, 30))) / 100;
        baseFilters.push(`volume=enable='between(t,${start},${end})':volume=${ov.toFixed(3)}`);
      }
    });
    preps.push(`[${baseLabel}]${baseFilters.join(",")}[abase]`);

    // Per-track prep chains
    const trackLabels = [];
    validTracks.forEach((entry) => {
      const inputIndex = nextInputIndex;
      nextInputIndex += 1;
      inputArgs.push("-i", entry.filePath);
      preps.push(buildAudioTrackChain(entry.track, inputIndex, entry.placement, entry.audioDuration));
      trackLabels.push(`[trk${inputIndex}]`);
    });

    // Final mix — normalize=0 preserves user volume settings
    const mixInputs = 1 + trackLabels.length;
    const filterComplex = [
      ...preps,
      `[abase]${trackLabels.join("")}amix=inputs=${mixInputs}:duration=first:dropout_transition=0:normalize=0[aout]`,
    ].join(";");

    const args = [
      "-y",
      "-i", inFile,
      ...inputArgs,
      "-filter_complex", filterComplex,
      "-map", "0:v",
      "-map", "[aout]",
      "-c:v", "copy",
      "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart",
      outFile,
    ];
    console.log("[AUDIO] FFmpeg filter_complex:", filterComplex);
    const result = spawnSync(FFMPEG_BIN, args, { stdio: "inherit", timeout: 600000 });
    if (!result.error && result.status === 0 && fs.existsSync(outFile)) {
      console.log("✅ Audio tracks applied successfully!");
      return true;
    }
    console.log("[AUDIO] audio pass failed, keeping previous output");
    return false;
  } catch (err) {
    console.error("[AUDIO] Unexpected error:", err.message);
    return false;
  } finally {
    for (const file of downloaded) {
      try { fs.unlinkSync(file); } catch {}
    }
  }
}

/**
 * Speed Control Functions using FFmpeg
 * Supports multiple speed modes:
 * - none: No speed change
 * - first_last: Speed up first N and last N seconds
 * - segments: Custom segments with different speeds
 */
function applySpeedControl(inputFile, tempFile, config) {
  const speedMode = config.speed_mode || "none";
  
  console.log("=== SPEED CONTROL ===");
  console.log("Speed Mode:", speedMode);
  
  if (speedMode === "none" || !speedMode) {
    console.log("Speed: No change, copying file...");
    copyFileSync(inputFile, tempFile);
    return;
  }
  
  const videoDuration = getVideoDuration(inputFile);
  console.log("Video Duration:", videoDuration);
  
  if (!videoDuration) {
    console.log("Could not determine duration, skipping speed control...");
    copyFileSync(inputFile, tempFile);
    return;
  }
  
  // WHOLE VIDEO MODE — single speed for entire video
  if (speedMode === "whole") {
    const speed = parseFloat(config.speed_whole_value || "2.0");
    console.log(`Whole video speed: ${speed}x`);
    applySpeedSegments(inputFile, tempFile, config, videoDuration, [
      { start: 0, end: videoDuration, speed: speed }
    ]);
    return;
  }

  if (speedMode === "first_last") {
    const firstSeconds = parseFloat(config.speed_first_seconds || "5");
    const firstSpeed = parseFloat(config.speed_first_value || "2.0");
    const lastSeconds = parseFloat(config.speed_last_seconds || "5");
    const lastSpeed = parseFloat(config.speed_last_value || "2.0");
    const middleSpeed = 1.0;
    
    console.log(`First ${firstSeconds}s: ${firstSpeed}x speed`);
    console.log(`Middle: ${middleSpeed}x (normal)`);
    console.log(`Last ${lastSeconds}s: ${lastSpeed}x speed`);
    
    applySpeedSegments(inputFile, tempFile, config, videoDuration, [
      { start: 0, end: Math.min(firstSeconds, videoDuration), speed: firstSpeed },
      { start: firstSeconds, end: Math.max(firstSeconds, videoDuration - lastSeconds), speed: middleSpeed },
      { start: Math.max(firstSeconds, videoDuration - lastSeconds), end: videoDuration, speed: lastSpeed }
    ]);
    return;
  }
  
  if (speedMode === "segments") {
    let segments = [];
    try {
      if (typeof config.speed_segments === "string") {
        segments = JSON.parse(config.speed_segments);
      } else if (Array.isArray(config.speed_segments)) {
        segments = config.speed_segments;
      }
    } catch (e) {
      console.log("Could not parse speed_segments:", e.message);
    }
    
    if (segments.length === 0) {
      console.log("No segments defined, skipping speed control...");
      copyFileSync(inputFile, tempFile);
      return;
    }
    
    console.log("Custom segments:", JSON.stringify(segments));
    applySpeedSegments(inputFile, tempFile, config, videoDuration, segments);
    return;
  }
  
  // Unknown mode, just copy
  console.log("Unknown speed mode, copying as-is...");
  copyFileSync(inputFile, tempFile);
}

function buildAtempoChain(speed) {
  // atempo only supports 0.5 to 2.0 per filter — chain multiple for other speeds
  if (speed <= 0) return "atempo=1.0";
  const filters = [];
  let remaining = speed;
  // For slow speeds (< 0.5), chain downward
  while (remaining < 0.5) {
    filters.push("atempo=0.5");
    remaining /= 0.5;
  }
  // For fast speeds (> 2.0), chain upward
  while (remaining > 2.0) {
    filters.push("atempo=2.0");
    remaining /= 2.0;
  }
  // Final remainder
  const clamped = Math.min(2.0, Math.max(0.5, remaining));
  filters.push(`atempo=${clamped.toFixed(4)}`);
  return filters.join(",");
}

function applySpeedSegments(inputFile, tempFile, config, videoDuration, segments) {
  // Filter and sort valid segments
  const validSegments = segments
    .filter(s => s && s.speed > 0 && s.end > s.start)
    .map(s => ({
      start: Math.max(0, s.start),
      end: Math.min(videoDuration, s.end),
      speed: s.speed
    }))
    .filter(s => s.end > s.start)
    .sort((a, b) => a.start - b.start);

  if (validSegments.length === 0) {
    console.log("No valid segments, copying as-is...");
    copyFileSync(inputFile, tempFile);
    return;
  }

  const hasAudio = hasAudioTrack(inputFile);

  // Build a complete timeline: fill gaps with 1x speed
  // Gap before first segment, between segments, after last segment
  const timeline = [];

  // Gap at start (0 to first segment)
  if (validSegments[0].start > 0) {
    timeline.push({ start: 0, end: validSegments[0].start, speed: 1.0 });
  }

  validSegments.forEach((seg, i) => {
    timeline.push(seg);
    // Gap between this segment and next
    if (i < validSegments.length - 1) {
      const gapStart = seg.end;
      const gapEnd = validSegments[i + 1].start;
      if (gapEnd > gapStart) {
        timeline.push({ start: gapStart, end: gapEnd, speed: 1.0 });
      }
    }
  });

  // Gap at end (last segment to video end)
  const lastSeg = validSegments[validSegments.length - 1];
  if (lastSeg.end < videoDuration) {
    timeline.push({ start: lastSeg.end, end: videoDuration, speed: 1.0 });
  }

  console.log("Timeline:", JSON.stringify(timeline));

  const videoFilters = [];
  const audioFilters = [];
  const concatParts = [];

  timeline.forEach((seg, i) => {
    const ptsValue = (1 / seg.speed).toFixed(6);

    // KEY FIX: setpts=PTS-STARTPTS resets timestamps to 0 after trim
    // then multiply by speed factor
    videoFilters.push(
      `[0:v]trim=start=${seg.start}:end=${seg.end},setpts=PTS-STARTPTS,setpts=${ptsValue}*PTS[v${i}]`
    );

    if (hasAudio) {
      const atempoChain = buildAtempoChain(seg.speed);
      audioFilters.push(
        `[0:a]atrim=start=${seg.start}:end=${seg.end},asetpts=PTS-STARTPTS,${atempoChain}[a${i}]`
      );
    }

    concatParts.push(`[v${i}]`);
    if (hasAudio) concatParts.push(`[a${i}]`);
  });

  const n = timeline.length;
  const concatAudio = hasAudio ? `:a=1` : "";
  const allFilters = [...videoFilters, ...audioFilters].join("; ");
  const complexFilter = `${allFilters}; ${concatParts.join("")}concat=n=${n}:v=1${concatAudio}[out]`;

  const encodeArgs = getOutputEncodeArgs(config, { disableAudio: !hasAudio });
  const cmd = `${FFMPEG} -hwaccel auto -y -i "${inputFile}" -filter_complex "${complexFilter}" -map "[out]" ${encodeArgs} -movflags +faststart "${tempFile}"`;

  console.log("Speed CMD:", cmd.substring(0, 300) + "...");

  try {
    execSync(cmd, { stdio: "inherit", timeout: 600000 });
    console.log("✅ Speed control applied successfully!");
  } catch (e) {
    console.error("Speed control failed:", e.message);
    console.log("Falling back to original file...");
    copyFileSync(inputFile, tempFile);
  }
}

/**
 * Advanced Audio Muting Functions using FFmpeg
 * Supports multiple mute modes:
 * - full_mute: Remove entire audio track
 * - fade_out: Fade out audio in last N seconds
 * - mute_last: Mute/cut audio in last N seconds
 * - mute_range: Mute audio between start and end times
 * - mute_between: Mute audio between two time points
 */
function applyAdvancedAudioMuting(tempFile, outputFile, config) {
  const muteMode = config.mute_mode || "fade_out";
  const audioFadeDuration = parseInt(config.audio_fade_duration || "5");
  console.log("=== APPLY AUDIO MUTING FUNCTION ===");
  console.log("config.mute_mode:", config.mute_mode);
  console.log("muteMode used:", muteMode);
  console.log("audioFadeDuration used:", audioFadeDuration);
  const muteLastSeconds = parseFloat(config.mute_last_seconds || "5");
  const muteRangeStart = parseFloat(config.mute_range_start || "0");
  const muteRangeEnd = parseFloat(config.mute_range_end || "0");
  
  const videoDuration = getVideoDuration(tempFile);
  console.log("=== Advanced Audio Muting ===");
  console.log("Mute Mode:", muteMode);
  console.log("Video Duration:", videoDuration);

  if (!hasAudioTrack(tempFile)) {
    console.log("No audio track found, remuxing as-is...");
    remuxWithFaststart(tempFile, outputFile, getOutputEncodeArgs(config));
    return;
  }

  switch (muteMode) {
    case "full_mute":
      console.log("Mode: Full Mute (removing entire audio track)");
      remuxWithFaststart(tempFile, outputFile, getOutputEncodeArgs(config, { disableAudio: true }));
      break;

    case "fade_out":
      console.log(`Mode: Fade Out (last ${audioFadeDuration}s)`);
      if (videoDuration && videoDuration > audioFadeDuration) {
        const fadeStart = videoDuration - audioFadeDuration;
        const cmd = `${FFMPEG} -hwaccel auto -y -i "${tempFile}" -af "afade=t=out:st=${fadeStart}:d=${audioFadeDuration}" ${getOutputEncodeArgs(config)} -movflags +faststart "${outputFile}"`;
        console.log("Fade CMD:", cmd);
        execSync(cmd, { stdio: "inherit", timeout: 300000 });
      } else {
        console.log("Could not determine video duration or video too short, keeping original audio...");
        remuxWithFaststart(tempFile, outputFile, getOutputEncodeArgs(config));
      }
      break;

    case "mute_last":
      console.log(`Mode: Mute Last (${muteLastSeconds}s)`);
      if (videoDuration && videoDuration > muteLastSeconds) {
        const keepEnd = videoDuration - muteLastSeconds;
        const cmd = `${FFMPEG} -hwaccel auto -y -i "${tempFile}" -af "volume=enable='between(t,${keepEnd},${videoDuration})':volume=0" ${getOutputEncodeArgs(config)} -movflags +faststart "${outputFile}"`;
        console.log("Mute Last CMD:", cmd);
        execSync(cmd, { stdio: "inherit", timeout: 300000 });
      } else {
        console.log("Could not determine video duration or video too short, keeping original audio...");
        remuxWithFaststart(tempFile, outputFile, getOutputEncodeArgs(config));
      }
      break;

    case "mute_range":
      console.log(`Mode: Mute Range (${muteRangeStart}s to ${muteRangeEnd}s)`);
      if (videoDuration && muteRangeEnd > muteRangeStart && muteRangeStart >= 0) {
        const actualEnd = Math.min(muteRangeEnd, videoDuration);
        // Mute audio between start and end using volume filter with enable expression
        const cmd = `${FFMPEG} -hwaccel auto -y -i "${tempFile}" -af "volume=enable='between(t,${muteRangeStart},${actualEnd})':volume=0" ${getOutputEncodeArgs(config)} -movflags +faststart "${outputFile}"`;
        console.log("Mute Range CMD:", cmd);
        execSync(cmd, { stdio: "inherit", timeout: 300000 });
      } else {
        console.log("Invalid range, keeping original audio...");
        remuxWithFaststart(tempFile, outputFile, getOutputEncodeArgs(config));
      }
      break;

    case "mute_between":
      console.log(`Mode: Mute Between (${muteRangeStart}s to ${muteRangeEnd}s)`);
      if (videoDuration && muteRangeEnd > muteRangeStart && muteRangeStart >= 0) {
        const actualEnd = Math.min(muteRangeEnd, videoDuration);
        // Same as mute_range but semantically different (could be extended)
        const cmd = `${FFMPEG} -hwaccel auto -y -i "${tempFile}" -af "volume=enable='between(t,${muteRangeStart},${actualEnd})':volume=0" ${getOutputEncodeArgs(config)} -movflags +faststart "${outputFile}"`;
        console.log("Mute Between CMD:", cmd);
        execSync(cmd, { stdio: "inherit", timeout: 300000 });
      } else {
        console.log("Invalid range, keeping original audio...");
        remuxWithFaststart(tempFile, outputFile, getOutputEncodeArgs(config));
      }
      break;

    default:
      console.log("Unknown mute mode, keeping original audio...");
      remuxWithFaststart(tempFile, outputFile, getOutputEncodeArgs(config));
      break;
  }
}

function main() {
  console.log("=== Process Video ===");
  console.log("Working dir:", process.cwd());
  console.log("Font dir:", FONT_DIR);

  if (!fs.existsSync(OUTPUT_DIR)) {
    console.log("Creating output dir...");
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  if (!fs.existsSync(INPUT_FILE)) {
    console.error("ERROR: Input video not found at: " + INPUT_FILE);
    console.log("Files in output dir:", fs.readdirSync(OUTPUT_DIR));
    process.exit(1);
  }

  const inputSize = fs.statSync(INPUT_FILE).size;
  console.log("Input: " + (inputSize / 1024 / 1024).toFixed(2) + " MB");

  let config = {};
  try {
    const configPath = path.join(process.cwd(), "automation-config.json");
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      console.log("Config loaded successfully");
      console.log("Config keys:", Object.keys(config).join(", "));
      console.log("Config preview:", JSON.stringify(config).substring(0, 500));
    } else {
      console.log("WARNING: Config file not found at:", configPath);
      console.log("Current dir:", process.cwd());
      console.log("Files in cwd:", fs.readdirSync(process.cwd()));
    }
  } catch (e) {
    console.log("Could not read config: " + e.message);
    console.log("Config path:", path.join(process.cwd(), "automation-config.json"));
  }

  // Duration settings
  const rawDuration = config.short_duration;
  const duration = parseInt(rawDuration || "58") || 58;
  const aspectRatio = config.aspect_ratio || "9:16";
  
  console.log("=== DURATION CONFIG ===");
  console.log("short_duration raw:", rawDuration, "(type:", typeof rawDuration, ")");
  console.log("Final duration:", duration, "seconds");
  console.log("Aspect ratio:", aspectRatio);
  console.log("========================");
  
  // Legacy support: mute_audio boolean
  const legacyMuteAudio = config.mute_audio === true || config.mute_audio === "true";
  
  // New advanced mute settings
  // Default to fade_out instead of full_mute for backward compatibility
  const muteMode = config.mute_mode || (legacyMuteAudio ? "fade_out" : "none");
  const audioFadeDuration = parseInt(config.audio_fade_duration || "5");
  console.log("=== AUDIO CONFIG DEBUG ===");
  console.log("mute_audio:", config.mute_audio, "(type:", typeof config.mute_audio, ")");
  console.log("mute_mode:", config.mute_mode, "(type:", typeof config.mute_mode, ")");
  console.log("audio_fade_duration:", config.audio_fade_duration, "(type:", typeof config.audio_fade_duration, ")");
  console.log("mute_last_seconds:", config.mute_last_seconds);
  console.log("mute_range_start:", config.mute_range_start);
  console.log("mute_range_end:", config.mute_range_end);
  console.log("legacyMuteAudio:", legacyMuteAudio);
  console.log("Final muteMode:", muteMode);
  console.log("Final audioFadeDuration:", audioFadeDuration + "s");
  console.log("=== END AUDIO CONFIG ===");
  
  // === SPEED CONTROL (Applied first) ===
  const speedMode = config.speed_mode || "none";
  if (speedMode !== "none") {
    console.log("=== APPLYING SPEED CONTROL ===");
    applySpeedControl(INPUT_FILE, SPEED_FILE, config);
    
    // Use speed-controlled file for further processing
    if (fs.existsSync(SPEED_FILE)) {
      console.log("Using speed-controlled file for further processing...");
    } else {
      console.log("Speed control file not created, using original input...");
      copyFileSync(INPUT_FILE, SPEED_FILE);
    }
  } else {
    console.log("Speed control: DISABLED");
    copyFileSync(INPUT_FILE, SPEED_FILE);
  }
  // === END SPEED CONTROL ===

  const isFit = aspectRatio.endsWith("-fit");
  const isOriginal = aspectRatio === "original";
  const baseRatio = aspectRatio.replace("-fit", "");

  const outputResolution = parseResolution(config.output_resolution);
  let width = outputResolution?.width || 1080;
  let height = outputResolution?.height || 1920;
  if (!outputResolution) {
    if (baseRatio === "16:9") { width = 1920; height = 1080; }
    else if (baseRatio === "1:1") { width = 1080; height = 1080; }
    else if (baseRatio === "4:5") { width = 1080; height = 1350; }
    else if (baseRatio === "21:9") { width = 1920; height = 823; }
  }

  let filters = [];

  if (isOriginal) {
    console.log("Mode: Original (no resize)");
  } else if (isFit) {
    console.log("Mode: Fit (no crop, black bars)");
    filters.push(`scale=${width}:${height}:force_original_aspect_ratio=decrease`);
    filters.push(`pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`);
  } else {
    console.log("Mode: Crop (fill and cut)");
    filters.push(`scale=${width}:${height}:force_original_aspect_ratio=increase`);
    filters.push(`crop=${width}:${height}`);
  }

  const topTaglines = Array.isArray(config.top_taglines) ? config.top_taglines : [];
  const bottomTaglines = Array.isArray(config.bottom_taglines) ? config.bottom_taglines : [];

  if (topTaglines.length > 0) {
    const tagline = topTaglines[Math.floor(Math.random() * topTaglines.length)];
    console.log("Adding top tagline:", tagline);
    const taglineFilter = buildTaglineDrawtext(tagline, config, "top", baseRatio, { width, height });
    if (taglineFilter) {
      filters.push(taglineFilter);
    }
  }

  if (bottomTaglines.length > 0) {
    const tagline = bottomTaglines[Math.floor(Math.random() * bottomTaglines.length)];
    console.log("Adding bottom tagline:", tagline);
    const taglineFilter = buildTaglineDrawtext(tagline, config, "bottom", baseRatio, { width, height });
    if (taglineFilter) {
      filters.push(taglineFilter);
    }
  }

  const brandingTopFilter = buildOverlayDrawtext(config.branding_text_top, config, {
    x: "30",
    y: "30",
    fontSize: 22,
    fontColor: "white@0.9",
    fontStyle: "medium"
  });
  if (brandingTopFilter) {
    filters.push(brandingTopFilter);
  }

  const brandingBottomFilter = buildOverlayDrawtext(config.branding_text_bottom, config, {
    x: "30",
    y: "h-text_h-30",
    fontSize: 22,
    fontColor: "white@0.9",
    fontStyle: "medium"
  });
  if (brandingBottomFilter) {
    filters.push(brandingBottomFilter);
  }

  const watermarkText = String(config.watermark_text || "").trim();
  if (watermarkText) {
    const watermarkFontSize = parseInt(config.watermark_fontsize || "24", 10) || 24;
    const watermarkPosition = String(config.watermark_position || "bottomright");
    const positionMap = {
      bottomright: { x: "w-text_w-30", y: "h-text_h-30" },
      bottomleft: { x: "30", y: "h-text_h-30" },
      topright: { x: "w-text_w-30", y: "30" },
      topleft: { x: "30", y: "30" }
    };
    const watermarkCoords = positionMap[watermarkPosition] || positionMap.bottomright;
    const watermarkFilter = buildOverlayDrawtext(watermarkText, config, {
      ...watermarkCoords,
      fontSize: watermarkFontSize,
      fontColor: "white@0.55",
      fontStyle: "medium",
      borderWidth: 1
    });
    if (watermarkFilter) {
      filters.push(watermarkFilter);
    }
  }

  // Job info overlay — bottom-right corner
  const jobId = process.env.JOB_ID;
  const automationId = process.env.AUTOMATION_ID;
  const segIndex = process.env.SEGMENT_INDEX;
  const segTotal = process.env.SEGMENT_TOTAL;
  if (jobId || automationId) {
    let overlayText = `Job #${jobId || '?'}`;
    if (automationId) overlayText += ` | Auto #${automationId}`;
    const jobInfoFilter = `drawtext=text='${overlayText}':fontsize=16:fontcolor=white@0.6:x=(w-text_w-20):y=(h-text_h-20):borderw=1:bordercolor=black@0.4`;
    filters.push(jobInfoFilter);
    console.log("[PROCESS] Job info overlay:", overlayText);
  }

  // Short counter overlay — top-right corner (for segment mode)
  if (segIndex !== undefined && segTotal !== undefined && Number(segTotal) > 1) {
    const shortLabel = `Short ${Number(segIndex) + 1}/${segTotal}`;
    const shortFilter = `drawtext=text='${shortLabel}':fontsize=18:fontcolor=white@0.7:x=(w-text_w-20):y=20:borderw=1:bordercolor=black@0.4`;
    filters.push(shortFilter);
    console.log("[PROCESS] Short counter overlay:", shortLabel);
  }

  const splitMode = config.split_mode || "chunk";
  const splitEnabled = config.split_enabled === true || config.split_enabled === "true";
  let splitSelectExpr = null;

  if (splitEnabled && splitMode === "advanced") {
    let splitRules = [];
    try {
      splitRules = typeof config.split_rules === "string" ? JSON.parse(config.split_rules) : (config.split_rules || []);
    } catch (e) { console.log("Could not parse split_rules:", e.message); }

    if (splitRules.length > 0) {
      const videoDuration = getVideoDuration(SPEED_FILE) || duration;
      console.log("Video duration for split calc:", videoDuration);

      const ruleExprs = splitRules.map(rule => {
        let start = 0, end = videoDuration;
        if (rule.region === "first") { end = Math.min(rule.region_value, videoDuration); }
        else if (rule.region === "last") { start = Math.max(0, videoDuration - rule.region_value); }
        else if (rule.region === "custom") { start = rule.region_start || 0; end = rule.region_end || videoDuration; }

        const interval = rule.interval || 1;
        const remove = rule.remove_duration || 0.1;
        // Fix: ensure keep is positive - keep frames where mod < keep
        const keep = Math.max(0.01, interval - remove);
        // Use gte to keep frames (output 0 when mod >= keep means drop)
        return `if(lt(t,${start}),1,if(gt(t,${end}),1,if(gte(mod(t-${start},${interval}),${keep}),0,1)))`;
      });

      splitSelectExpr = ruleExprs.length === 1 ? ruleExprs[0] : ruleExprs.reduce((a, b) => `if(${a},${b},0)`);
      console.log("Split select expr:", splitSelectExpr);
    }
  }

  let useComplexFilter = !!splitSelectExpr;

  const filterStr = filters.length > 0 ? filters.join(",") : "null";

  function tryFallbackCopy() {
    try {
      execSync(`${FFMPEG} -y -i "${SPEED_FILE}" -t ${duration} -c copy -movflags +faststart "${TEMP_FILE}"`, {
        stdio: "inherit", timeout: 300000
      });
    } catch (e2) {
      console.error("Copy fallback failed:", e2.message);
      process.exit(1);
    }
  }

  console.log("Running FFmpeg...");
  let cmd;

  if (useComplexFilter) {
    const vfChain = filterStr === "null" ? "" : filterStr + ",";
    const hasAudio = hasAudioTrack(SPEED_FILE);
    let complexFilter, mapArgs;
    if (hasAudio) {
      complexFilter = `[0:v]${vfChain}select='${splitSelectExpr}',setpts=N/FRAME_RATE/TB[v];[0:a]aselect='${splitSelectExpr}',asetpts=N/SR/TB[a]`;
      mapArgs = `-map "[v]" -map "[a]"`;
    } else {
      complexFilter = `[0:v]${vfChain}select='${splitSelectExpr}',setpts=N/FRAME_RATE/TB[v]`;
      mapArgs = `-map "[v]"`;
    }
      cmd = `${FFMPEG} -hwaccel auto -y -i "${SPEED_FILE}" -t ${duration} -filter_complex "${complexFilter}" ${mapArgs} ${getOutputEncodeArgs(config, { disableAudio: !hasAudio })} -movflags +faststart "${TEMP_FILE}"`;
  } else {
    cmd = `${FFMPEG} -hwaccel auto -y -i "${SPEED_FILE}" -t ${duration} -vf "${filterStr}" ${getOutputEncodeArgs(config)} -movflags +faststart "${TEMP_FILE}"`;
  }

  console.log("CMD:", cmd);

  try {
    execSync(cmd, { stdio: "inherit", timeout: 600000 });
  } catch (e) {
    console.error("FFmpeg error:", e.message);
    if (process.env.FFMPEG_FALLBACK === 'ultrafast') {
      console.log("Ultrafast fallback mode...");
      const ultrafastCmd = `${FFMPEG} -hwaccel auto -y -i "${SPEED_FILE}" -t ${duration} -vf "${filterStr === 'null' ? 'null' : filterStr}" -c:v libx264 -preset ultrafast -crf 30 -c:a aac -b:a 96k -pix_fmt yuv420p -movflags +faststart "${TEMP_FILE}"`;
      try {
        execSync(ultrafastCmd, { stdio: "inherit", timeout: 900000 });
        console.log("Ultrafast fallback succeeded!");
      } catch {
        console.error("Ultrafast fallback also failed. Trying copy...");
        tryFallbackCopy();
      }
    } else {
      tryFallbackCopy();
    }
  }

  if (!fs.existsSync(TEMP_FILE)) {
    console.error("ERROR: TEMP_FILE not created!");
    console.log("Expected:", TEMP_FILE);
    process.exit(1);
  }
  console.log("TEMP_FILE created successfully:", TEMP_FILE);

  // === OVERLAY PASS (image / video / logo overlays) ===
  // Applied after the main scale/crop+drawtext pass, before audio muting.
  // Backward compatible: empty/undefined overlays leaves output unchanged.
  let stageFile = TEMP_FILE;
  let overlays = config.overlays;
  if (typeof overlays === "string") {
    try { overlays = JSON.parse(overlays); } catch { overlays = []; }
  }
  if (Array.isArray(overlays) && overlays.length > 0) {
    const overlaid = applyOverlays(TEMP_FILE, OVERLAY_FILE, overlays, config, width, height);
    if (overlaid) {
      stageFile = OVERLAY_FILE;
    }
  } else {
    console.log("Overlays: none");
  }

  // Apply advanced audio muting
  if (muteMode !== "none") {
    console.log("Applying audio muting...");
    applyAdvancedAudioMuting(stageFile, OUTPUT_FILE, config);
  } else {
    console.log("Audio Processing: Original (no muting)");
    console.log("Staged file already has faststart, copying directly to OUTPUT_FILE...");
    fs.copyFileSync(stageFile, OUTPUT_FILE);
  }

  // === AUDIO TRACKS PASS (Audio tab) ===
  // Applied after mute — mute only touches the original audio, user-added
  // tracks are layered last. Backward compatible: empty config leaves output unchanged.
  let audioTracks = config.audio_tracks;
  if (typeof audioTracks === "string") {
    try { audioTracks = JSON.parse(audioTracks); } catch { audioTracks = []; }
  }
  if (Array.isArray(audioTracks) && audioTracks.length > 0) {
    const audioApplied = applyAudioTracks(OUTPUT_FILE, AUDIOTRACK_FILE, audioTracks, config);
    if (audioApplied) {
      fs.copyFileSync(AUDIOTRACK_FILE, OUTPUT_FILE);
    } else {
      console.log("[AUDIO] audio tracks pass skipped/failed, keeping previous output");
    }
  } else {
    console.log("Audio tracks: none");
  }

  try { fs.unlinkSync(TEMP_FILE); } catch (e) {}
  try { fs.unlinkSync(SPEED_FILE); } catch (e) {}
  try { fs.unlinkSync(OVERLAY_FILE); } catch (e) {}
  try { fs.unlinkSync(AUDIOTRACK_FILE); } catch (e) {}

  if (!fs.existsSync(OUTPUT_FILE)) {
    console.error("ERROR: OUTPUT_FILE not created!");
    console.log("Expected:", OUTPUT_FILE);
    process.exit(1);
  }
  console.log("OUTPUT_FILE created successfully:", OUTPUT_FILE);

  const outputSize = fs.statSync(OUTPUT_FILE).size;
  console.log("Output: " + (outputSize / 1024 / 1024).toFixed(2) + " MB");
  console.log("Audio Processing:", muteMode !== "none" ? `Muted (${muteMode})` : "Original");
  console.log("Speed Processing:", speedMode !== "none" ? `Enabled (${speedMode})` : "Disabled");
  console.log("SUCCESS!");
  process.exit(0);
}

main();
