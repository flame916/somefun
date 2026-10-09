import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME_BIN || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const TARGET = process.env.CDP_URL || "http://127.0.0.1:8000/game-project/code/";
const VIEWPORTS = (process.env.MOBILE_VIEWPORTS || "1440x900,375x667,390x844")
  .split(",")
  .map((value) => value.trim().split("x").map(Number))
  .filter(([width, height]) => Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0);
if (!VIEWPORTS.length) throw new Error("MOBILE_VIEWPORTS must contain at least one WIDTHxHEIGHT value");
const VIEWPORT_LABEL = VIEWPORTS.map(([width, height]) => `${width}x${height}`).join(", ");
const SCREENS = [
  "home",
  "soul_test",
  "role_pick",
  "event_guide",
  "event_later",
  "d20_result",
  "result_beat",
  "continuation",
  "interlude",
  "fate_window",
  "karma_knock",
  "cliff",
  "rebirth",
  "birth_pick",
  "study_dao",
  "cycle_recap"
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-features=OptimizationHints,MediaRouter",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-gpu-compositing",
    "--disable-software-rasterizer",
    "--disable-dev-shm-usage",
    "--mute-audio",
    "--remote-allow-origins=*",
    "--remote-debugging-port=0",
    `--user-data-dir=${join(tmpdir(), `cdp-layout-${Date.now()}`)}`,
    "about:blank"
  ],
  { stdio: ["ignore", "ignore", "pipe"] }
);

let stderr = "";
let connectStarted = false;
chrome.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
  const match = stderr.match(/DevTools listening on ws:\/\/[^\s]+:(\d+)\//);
  if (match && !connectStarted) {
    connectStarted = true;
    connect(Number(match[1]));
  }
});

let socket;
let nextId = 1;
let emulatedMobile = false;
const pending = new Map();
const jsErrors = [];
let connected = false;
let eventChoicePaintChecked = false;

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, 10000);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      }
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    const description = details.exception?.description || details.exception?.value || details.text || "unknown page exception";
    throw new Error(`page exception: ${description}`);
  }
  return result.result?.value;
}

async function waitFor(expression, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return true;
    await sleep(120);
  }
  return false;
}

async function clickFirst(selector, label) {
  const target = await evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return null;
    node.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = node.getBoundingClientRect();
    const x = (rect.left + rect.right) / 2;
    const y = (rect.top + rect.bottom) / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      x, y,
      width: rect.width,
      height: rect.height,
      top: rect.top,
      bottom: rect.bottom,
      hit: hit === node || node.contains(hit)
    };
  })()`);
  if (!target) throw new Error(`click target missing at ${label}: ${selector}`);
  if (target.width < 44 || target.height < 44) throw new Error(`${label}: tap target too small (${target.width}x${target.height})`);
  if (target.top < 0 || target.bottom > await evaluate("window.innerHeight")) throw new Error(`${label}: target not reachable in viewport`);
  if (!target.hit) throw new Error(`${label}: target covered by another element`);
  const activated = await evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return false;
    node.click();
    return true;
  })()`);
  if (!activated) throw new Error(`${label}: activation failed after visibility checks`);
  await sleep(80);
}

async function clickHomePrimary(expectedLabel) {
  const label = await evaluate(`document.querySelector('.home-actions .primary-btn .button-label')?.textContent?.trim() || ''`);
  if (label !== expectedLabel) throw new Error(`home primary CTA: expected ${expectedLabel}, got ${label || '(missing)'}`);
  await clickFirst('.home-actions .primary-btn', `home primary CTA (${expectedLabel})`);
}

async function assertChoiceList(screen) {
  const result = await evaluate(`(() => {
    const buttons = Array.from(document.querySelectorAll('.event-choice'));
    if (!buttons.length) return { count: 0, firstFullyVisible: false, options: [] };
    const first = buttons[0].getBoundingClientRect();
    const firstFullyVisible = first.top >= 0 && first.bottom <= window.innerHeight && first.width > 0 && first.height > 0;
    const options = buttons.map((node, index) => {
      node.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = node.getBoundingClientRect();
      const x = (rect.left + rect.right) / 2;
      const y = (rect.top + rect.bottom) / 2;
      const hit = document.elementFromPoint(x, y);
      return {
        index,
        width: rect.width,
        height: rect.height,
        top: rect.top,
        bottom: rect.bottom,
        reachable: rect.top >= 0 && rect.bottom <= window.innerHeight,
        hit: hit === node || node.contains(hit)
      };
    });
    return { count: buttons.length, firstFullyVisible, options };
  })()`);
  if (result.count !== 3) throw new Error(`${screen}: expected 3 visible choices, got ${result.count}`);
  if (!result.firstFullyVisible) throw new Error(`${screen}: first choice is not visible before scrolling`);
  for (const option of result.options) {
    if (option.width < 44 || option.height < 44) throw new Error(`${screen}: choice ${option.index + 1} tap target too small`);
    if (!option.reachable) throw new Error(`${screen}: choice ${option.index + 1} cannot be reached in viewport`);
    if (!option.hit) throw new Error(`${screen}: choice ${option.index + 1} is covered by another element`);
  }
  await assertEventChoiceLayers(screen);
  await assertEventChoicePaint(screen);
  await assertChoiceRowVisualContract(screen);
  return result.count;
}

async function assertEventChoiceLayers(screen) {
  const result = await evaluate(`(() => {
    const contentSelector = [
      '.choice-top',
      '.effects-row',
      '.failure-row',
      '.action-line'
    ].map((selector) => ':scope > ' + selector).join(', ');

    return Array.from(document.querySelectorAll('.event-choice')).map((button, index) => {
      const skin = button.querySelector(':scope > .button-skin');
      const skinStyle = skin ? getComputedStyle(skin) : null;
      const layers = Array.from(button.querySelectorAll(contentSelector)).map((layer) => {
        const style = getComputedStyle(layer);
        const rect = layer.getBoundingClientRect();
        return {
          className: layer.className,
          text: (layer.textContent || '').trim(),
          color: style.color,
          position: style.position,
          zIndex: style.zIndex,
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          width: rect.width,
          height: rect.height
        };
      });
      return {
        index,
        backgroundColor: getComputedStyle(button).backgroundColor,
        borderColor: getComputedStyle(button).borderTopColor,
        borderStyle: getComputedStyle(button).borderTopStyle,
        borderWidth: getComputedStyle(button).borderTopWidth,
        skinZIndex: skinStyle?.zIndex || null,
        skinPosition: skinStyle?.position || null,
        layers
      };
    });
  })()`);

  if (!result.length) throw new Error(`${screen}: no event choices found for layer checks`);
  for (const button of result) {
    if (button.backgroundColor === 'transparent' || button.backgroundColor === 'rgba(0, 0, 0, 0)') {
      throw new Error(`${screen}: event choice ${button.index + 1} has transparent computed background`);
    }
    if (button.borderStyle === 'none' || button.borderWidth === '0px' || button.borderColor === 'rgba(0, 0, 0, 0)') {
      throw new Error(`${screen}: event choice ${button.index + 1} has no visible computed border`);
    }
    if (button.skinPosition !== 'absolute') throw new Error(`${screen}: event choice ${button.index + 1} button skin is not absolutely layered`);
    const skinZIndex = Number(button.skinZIndex);
    if (!Number.isFinite(skinZIndex)) throw new Error(`${screen}: event choice ${button.index + 1} button skin has no numeric z-index`);
    for (const layer of button.layers) {
      if (!layer.text) throw new Error(`${screen}: event choice ${button.index + 1} ${layer.className} has no text`);
      if (layer.display === 'none' || layer.visibility === 'hidden' || Number(layer.opacity) <= 0 || layer.width <= 0 || layer.height <= 0) {
        throw new Error(`${screen}: event choice ${button.index + 1} ${layer.className} is not visibly rendered`);
      }
      if (layer.position === 'static') throw new Error(`${screen}: event choice ${button.index + 1} ${layer.className} is not positioned above the skin`);
      const layerZIndex = Number(layer.zIndex);
      if (!Number.isFinite(layerZIndex) || layerZIndex <= skinZIndex) {
        throw new Error(`${screen}: event choice ${button.index + 1} ${layer.className} z-index ${layer.zIndex} is not above button skin ${button.skinZIndex}`);
      }
    }
  }
}

function colorRgb(value) {
  const match = String(value).match(/rgba?\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)/i);
  return match ? match.slice(1, 4).map(Number) : null;
}

function contrastRatio(foreground, background) {
  const fg = colorRgb(foreground);
  const bg = colorRgb(background);
  if (!fg || !bg) return 0;
  const luminance = (rgb) => rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  const light = luminance(fg);
  const dark = luminance(bg);
  return (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05);
}

async function assertChoiceRowVisualContract(screen) {
  const result = await evaluate(`(() => ({ viewportWidth: window.innerWidth, rows: Array.from(document.querySelectorAll('.choice-row')).map((node) => {
    const style = getComputedStyle(node);
    const label = node.querySelector('.choice-label, .button-label, .choice-top');
    const labelStyle = label ? getComputedStyle(label) : null;
    return {
      backgroundColor: style.backgroundColor,
      borderColor: style.borderTopColor,
      borderStyle: style.borderTopStyle,
      borderWidth: style.borderTopWidth,
      color: labelStyle?.color || style.color,
      overflowX: style.overflowX,
      width: node.getBoundingClientRect().width,
      right: node.getBoundingClientRect().right
    };
  }) }))()`);
  if (!result.rows.length) throw new Error(`${screen}: no choice rows for visual contract`);
  for (const row of result.rows) {
    if (row.backgroundColor === 'transparent' || row.backgroundColor === 'rgba(0, 0, 0, 0)') throw new Error(`${screen}: choice row background is transparent`);
    if (row.borderStyle === 'none' || row.borderWidth === '0px' || row.borderColor === 'rgba(0, 0, 0, 0)') throw new Error(`${screen}: choice row border is invisible`);
    if (contrastRatio(row.color, row.backgroundColor) < 4.5) throw new Error(`${screen}: choice row text contrast is below 4.5:1`);
    if (row.overflowX !== 'visible' && row.width <= 0) throw new Error(`${screen}: choice row has invalid layout width`);
    if (row.right > result.viewportWidth + 0.5) throw new Error(`${screen}: choice row overflows viewport`);
  }
}

async function captureViewport() {
  return (await send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false
  })).data;
}

async function compareScreenshotPixels(before, after, clip) {
  return evaluate(`(async () => {
    const loadImage = (src) => new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("screenshot image load failed"));
      image.src = src;
    });
    const [beforeImage, afterImage] = await Promise.all([
      loadImage(${JSON.stringify(`data:image/png;base64,${before}`)}),
      loadImage(${JSON.stringify(`data:image/png;base64,${after}`)})
    ]);
    if (beforeImage.width !== afterImage.width || beforeImage.height !== afterImage.height) {
      return { width: beforeImage.width, height: afterImage.height, changed: -1, total: 0, maxDelta: 0 };
    }
    const scaleX = beforeImage.width / window.innerWidth;
    const scaleY = beforeImage.height / window.innerHeight;
    const left = Math.max(0, Math.floor(${clip.left} * scaleX));
    const top = Math.max(0, Math.floor(${clip.top} * scaleY));
    const right = Math.min(beforeImage.width, Math.ceil(${clip.right} * scaleX));
    const bottom = Math.min(beforeImage.height, Math.ceil(${clip.bottom} * scaleY));
    const width = right - left;
    const height = bottom - top;
    if (width < 2 || height < 2) {
      throw new Error("event choice paint check produced an empty screenshot clip");
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(beforeImage, left, top, width, height, 0, 0, width, height);
    const beforePixels = context.getImageData(0, 0, width, height).data;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(afterImage, left, top, width, height, 0, 0, width, height);
    const afterPixels = context.getImageData(0, 0, width, height).data;
    let changed = 0;
    let maxDelta = 0;
    for (let offset = 0; offset < beforePixels.length; offset += 4) {
      const delta = Math.max(
        Math.abs(beforePixels[offset] - afterPixels[offset]),
        Math.abs(beforePixels[offset + 1] - afterPixels[offset + 1]),
        Math.abs(beforePixels[offset + 2] - afterPixels[offset + 2]),
        Math.abs(beforePixels[offset + 3] - afterPixels[offset + 3])
      );
      if (delta > 8) changed += 1;
      if (delta > maxDelta) maxDelta = delta;
    }
    return {
      width: canvas.width,
      height: canvas.height,
      changed,
      total: width * height,
      maxDelta
    };
  })()`);
}

async function measureScreenshotContrast(screenshot, clip) {
  return evaluate(`(async () => {
    const loadImage = (src) => new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("screenshot image load failed"));
      image.src = src;
    });
    const image = await loadImage(${JSON.stringify(`data:image/png;base64,${screenshot}`)});
    const scaleX = image.width / window.innerWidth;
    const scaleY = image.height / window.innerHeight;
    const left = Math.max(0, Math.floor(${clip.left} * scaleX));
    const top = Math.max(0, Math.floor(${clip.top} * scaleY));
    const right = Math.min(image.width, Math.ceil(${clip.right} * scaleX));
    const bottom = Math.min(image.height, Math.ceil(${clip.bottom} * scaleY));
    const width = right - left;
    const height = bottom - top;
    if (width < 2 || height < 2) throw new Error("screenshot contrast check produced an empty clip");
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(image, left, top, width, height, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data;
    const channelLuminance = (value) => {
      const channel = value / 255;
      return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    };
    let minLuminance = 1;
    let maxLuminance = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      const luminance =
        0.2126 * channelLuminance(pixels[offset]) +
        0.7152 * channelLuminance(pixels[offset + 1]) +
        0.0722 * channelLuminance(pixels[offset + 2]);
      minLuminance = Math.min(minLuminance, luminance);
      maxLuminance = Math.max(maxLuminance, luminance);
    }
    return {
      width,
      height,
      minLuminance,
      maxLuminance,
      contrast: (maxLuminance + 0.05) / (minLuminance + 0.05)
    };
  })()`);
}

async function assertRebirthAllocationControls() {
  const clickAllocationButton = async (rowIndex, direction, label) => {
    const selector = direction === "increase"
      ? ".alloc-level + .icon-button"
      : ".alloc-name + .icon-button";
    const target = await evaluate(`(() => {
      const row = document.querySelectorAll('.rebirth .alloc-row')[${rowIndex}];
      const node = row?.querySelector(${JSON.stringify(selector)});
      if (!node) return null;
      node.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = node.getBoundingClientRect();
      const x = (rect.left + rect.right) / 2;
      const y = (rect.top + rect.bottom) / 2;
      const hit = document.elementFromPoint(x, y);
      const result = {
        scrollBefore: window.scrollY,
        width: rect.width,
        height: rect.height,
        top: rect.top,
        bottom: rect.bottom,
        hit: hit === node || node.contains(hit)
      };
      node.click();
      return result;
    })()`);
    if (!target) throw new Error(`rebirth: allocation ${direction} button missing`);
    if (target.width < 44 || target.height < 44) {
      throw new Error(`rebirth: allocation ${direction} tap target too small (${target.width}x${target.height})`);
    }
    if (target.top < 0 || target.bottom > await evaluate("window.innerHeight")) {
      throw new Error(`rebirth: allocation ${direction} target not reachable in viewport`);
    }
    if (!target.hit) throw new Error(`rebirth: allocation ${direction} target covered by another element`);
    return target;
  };

  const setup = await evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll('.rebirth .alloc-row'));
    const row = rows.find((candidate) => {
      const button = candidate.querySelector('.alloc-level + .icon-button');
      return button && !button.disabled;
    });
    if (!row) return null;
    const minus = row.querySelector('.icon-button');
    const plus = row.querySelector('.alloc-level + .icon-button');
    plus.scrollIntoView({ block: 'center', inline: 'center' });
    const describe = (button) => {
      const rect = button.getBoundingClientRect();
      const style = getComputedStyle(button);
      return {
        rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
        backgroundColor: style.backgroundColor,
        color: style.color,
        symbol: button.querySelector('.symbol-glyph')?.textContent || '',
        symbolButton: button.classList.contains('symbol-button'),
        imageCount: button.querySelectorAll('img').length
      };
    };
    return {
      rowIndex: rows.indexOf(row),
      levelBefore: Number(row.querySelector('.alloc-level')?.textContent || -1),
      scrollY: window.scrollY,
      plus: describe(plus),
      minus: describe(minus),
      minusDisabled: minus.disabled
    };
  })()`);
  if (!setup) throw new Error("rebirth: no enabled allocation increase button");
  if (setup.rowIndex < 0 || !(setup.levelBefore >= 0 && setup.levelBefore < 5)) {
    throw new Error(`rebirth: invalid allocation increase state ${JSON.stringify(setup)}`);
  }
  if (setup.scrollY <= 0) throw new Error("rebirth: allocation controls could not be scrolled into view");
  if (!setup.plus.symbolButton || setup.plus.symbol !== "+" || setup.plus.imageCount !== 0) {
    throw new Error(`rebirth: allocation increase is not rendered as an HTML symbol (${JSON.stringify(setup.plus)})`);
  }
  if (!setup.minus.symbolButton || setup.minus.symbol !== "-" || setup.minus.imageCount !== 0) {
    throw new Error(`rebirth: allocation decrease is not rendered as an HTML symbol (${JSON.stringify(setup.minus)})`);
  }
  if (!setup.minusDisabled) {
    throw new Error("rebirth: allocation decrease should start disabled at level zero");
  }
  const inset = 8;
  const measureButtonContrast = async (button, label) => {
    if (!/^rgb\(/.test(button.backgroundColor) || button.backgroundColor === "rgba(0, 0, 0, 0)") {
      throw new Error(`rebirth: ${label} has no contrast background (${button.backgroundColor})`);
    }
    const screenshot = await captureViewport();
    const contrast = await measureScreenshotContrast(screenshot, {
      left: button.rect.left + inset,
      top: button.rect.top + inset,
      right: button.rect.right - inset,
      bottom: button.rect.bottom - inset
    });
    if (contrast.contrast < 4.5) {
      throw new Error(`rebirth: ${label} contrast too low (${contrast.contrast.toFixed(2)}:1)`);
    }
    return contrast.contrast;
  };

  const plusContrast = await measureButtonContrast(setup.plus, "allocation increase icon");
  await measureButtonContrast(setup.minus, "disabled allocation decrease icon");

  const increaseClick = await clickAllocationButton(setup.rowIndex, "increase", "increase allocation");
  await sleep(240);
  const after = await evaluate(`(() => {
    const row = document.querySelectorAll('.rebirth .alloc-row')[${setup.rowIndex}];
    const minus = row?.querySelector('.icon-button');
    const rect = minus?.getBoundingClientRect();
    return {
      level: Number(row?.querySelector('.alloc-level')?.textContent || -1),
      scrollY: window.scrollY,
      minusDisabled: minus?.disabled,
      minusRect: rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } : null
    };
  })()`);
  if (after.level !== setup.levelBefore + 1) {
    throw new Error(`rebirth: allocation level did not increase (${setup.levelBefore} -> ${after.level})`);
  }
  if (after.scrollY <= 0 || Math.abs(after.scrollY - increaseClick.scrollBefore) > 2) {
    throw new Error(`rebirth: allocation click moved viewport (${increaseClick.scrollBefore} -> ${after.scrollY})`);
  }
  if (after.minusDisabled || !after.minusRect) {
    throw new Error("rebirth: allocation decrease did not become enabled after increase");
  }
  await measureButtonContrast(
    { rect: after.minusRect, backgroundColor: await evaluate(`getComputedStyle(document.querySelectorAll('.rebirth .alloc-row')[${setup.rowIndex}].querySelector('.icon-button')).backgroundColor`) },
    "enabled allocation decrease icon"
  );

  const decreaseClick = await clickAllocationButton(setup.rowIndex, "decrease", "decrease allocation");
  await sleep(240);
  const restored = await evaluate(`(() => {
    const row = document.querySelectorAll('.rebirth .alloc-row')[${setup.rowIndex}];
    return {
      level: Number(row?.querySelector('.alloc-level')?.textContent || -1),
      scrollY: window.scrollY,
      minusDisabled: row?.querySelector('.icon-button')?.disabled
    };
  })()`);
  if (restored.level !== setup.levelBefore) {
    throw new Error(`rebirth: allocation decrease did not restore level (${after.level} -> ${restored.level})`);
  }
  if (restored.scrollY <= 0 || Math.abs(restored.scrollY - decreaseClick.scrollBefore) > 2) {
    throw new Error(`rebirth: allocation decrease moved viewport (${decreaseClick.scrollBefore} -> ${restored.scrollY})`);
  }
  if (!restored.minusDisabled) {
    throw new Error("rebirth: allocation decrease did not return to disabled at level zero");
  }
  return { plusContrast };
}

async function assertEventChoicePaint(screen) {
  if (eventChoicePaintChecked) return;
  eventChoicePaintChecked = true;
  const count = await evaluate(`document.querySelectorAll('.event-choice').length`);
  if (count !== 3) throw new Error(`${screen}: expected 3 event choices for paint checks, got ${count}`);

  for (let index = 0; index < count; index += 1) {
    const clip = await evaluate(`(() => {
      const row = document.querySelectorAll('.event-choice')[${index}];
      row.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = row.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    })()`);
    const before = await captureViewport();
    let after;
    try {
      await evaluate(`(() => {
        const row = document.querySelectorAll('.event-choice')[${index}];
        const layers = Array.from(row.querySelectorAll(':scope > .choice-top, :scope > .effects-row, :scope > .failure-row, :scope > .action-line'));
        for (const layer of layers) {
          layer.__mobileLayoutVisibility = layer.style.visibility;
          layer.style.visibility = 'hidden';
        }
        return layers.length;
      })()`);
      await sleep(40);
      after = await captureViewport();
    } finally {
      await evaluate(`(() => {
        const row = document.querySelectorAll('.event-choice')[${index}];
        const layers = Array.from(row.querySelectorAll(':scope > .choice-top, :scope > .effects-row, :scope > .failure-row, :scope > .action-line'));
        for (const layer of layers) {
          layer.style.visibility = layer.__mobileLayoutVisibility || '';
          delete layer.__mobileLayoutVisibility;
        }
      })()`);
    }
    const diff = await compareScreenshotPixels(before, after, clip);
    if (diff.changed < 24 || diff.maxDelta < 24) {
      throw new Error(`${screen}: event choice ${index + 1} content produced no painted pixel difference (changed=${diff.changed}, maxDelta=${diff.maxDelta})`);
    }
  }
}

async function assertChoiceRowText(screen, { minCount = 0, selector = ".choice-row", labelSelector = ".choice-label, .button-label" } = {}) {
  const result = await evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll(${JSON.stringify(selector)})).filter((node) => {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0;
    });

    const details = rows.map((node, index) => {
      node.scrollIntoView({ block: 'center', inline: 'center' });
      const rowRect = node.getBoundingClientRect();
      const candidates = Array.from(node.querySelectorAll(${JSON.stringify(labelSelector)})).map((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
          element,
          text: (element.textContent || '').trim(),
          visible: style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0
        };
      });
      const label = candidates.find((item) => item.text && item.visible);
      if (!label) {
        return { index, text: '', labelVisible: false, insideRow: false, clipped: true, covered: true };
      }

      const rect = label.element.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      const insideRow = rect.left >= rowRect.left - 0.5 && rect.right <= rowRect.right + 0.5 && rect.top >= rowRect.top - 0.5 && rect.bottom <= rowRect.bottom + 0.5;
      const covered = !(hit === label.element || label.element.contains(hit) || node.contains(hit));

      let clip = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      for (let parent = label.element.parentElement; parent; parent = parent.parentElement) {
        const overflow = getComputedStyle(parent);
        if (overflow.overflowX !== 'visible' || overflow.overflowY !== 'visible') {
          const parentRect = parent.getBoundingClientRect();
          clip = {
            left: Math.max(clip.left, parentRect.left),
            top: Math.max(clip.top, parentRect.top),
            right: Math.min(clip.right, parentRect.right),
            bottom: Math.min(clip.bottom, parentRect.bottom)
          };
        }
      }
      const clipped = clip.right - clip.left < rect.width - 0.5 || clip.bottom - clip.top < rect.height - 0.5;
      return { index, text: label.text, labelVisible: true, insideRow, clipped, covered };
    });

    return { count: rows.length, details };
  })()`);

  if (result.count < minCount) throw new Error(`${screen}: expected at least ${minCount} choice rows, got ${result.count}`);
  for (const row of result.details) {
    if (!row.text) throw new Error(`${screen}: choice ${row.index + 1} has no visible text`);
    if (!row.labelVisible) throw new Error(`${screen}: choice ${row.index + 1} label is hidden`);
    if (!row.insideRow) throw new Error(`${screen}: choice ${row.index + 1} text overflows its button`);
    if (row.clipped) throw new Error(`${screen}: choice ${row.index + 1} text is clipped`);
    if (row.covered) throw new Error(`${screen}: choice ${row.index + 1} text is covered`);
  }
  return result.count;
}

async function assertTimeExplanation(screen) {
  const cards = await evaluate(`Array.from(document.querySelectorAll('.time-ledger')).map((card) => ({
    heading: card.querySelector('.panel-title')?.textContent || '',
    reason: card.querySelector('.time-reason')?.textContent || '',
    basis: card.querySelector('.time-basis')?.textContent || '',
    ledger: card.querySelector('.screen-copy')?.textContent || ''
  }))`);
  for (const card of cards) {
    if (!card.reason.trim()) throw new Error(`${screen}: time change has no reason`);
    if (!card.basis.trim()) throw new Error(`${screen}: time change has no event basis`);
    if (card.heading.includes('时间推进') && (!card.ledger.includes('年龄') || !card.ledger.includes('剩余寿元'))) {
      throw new Error(`${screen}: time change is missing ages or years`);
    }
    if (card.heading.includes('寿元消耗') && !card.ledger.includes('剩余寿元')) {
      throw new Error(`${screen}: lifespan change is missing before/after values`);
    }
  }
  return cards.length;
}

async function assertTimeBeats(screen) {
  const result = await evaluate(`(() => {
    const card = document.querySelector('.time-beats-card');
    if (!card) return { present: false, heading: '', entries: [] };
    return {
      present: true,
      heading: card.querySelector('.panel-title')?.textContent?.trim() || '',
      entries: Array.from(card.querySelectorAll('.time-beat')).map((entry) => entry.textContent?.trim() || '')
    };
  })()`);
  if (!result.present) return 0;
  if (result.heading !== "时间节拍") throw new Error(`${screen}: time beats heading is ${result.heading || '(missing)'}`);
  if (!result.entries.length) throw new Error(`${screen}: time beats card has no rendered entries`);
  for (const entry of result.entries) {
    if (!entry) throw new Error(`${screen}: time beat entry is blank`);
    if (entry.includes("[object Object]")) throw new Error(`${screen}: time beat rendered as [object Object]`);
  }
  return result.entries.length;
}

async function assertResultBeatOrder(screen) {
  const result = await evaluate(`(() => {
    const root = document.querySelector('.result_beat .content-column');
    if (!root) return null;
    const selectors = ['.result-card', '.delta-card', '.attr-panel', '.result-continue'];
    const nodes = selectors.map((selector) => root.querySelector(selector));
    return {
      missing: selectors.filter((selector, index) => !nodes[index]),
      positions: nodes.map((node) => node ? Array.prototype.indexOf.call(root.children, node) : -1)
    };
  })()`);
  if (!result) throw new Error(`${screen}: result beat root missing`);
  if (result.missing.length) throw new Error(`${screen}: result beat missing ${result.missing.join(', ')}`);
  for (let index = 1; index < result.positions.length; index += 1) {
    if (result.positions[index] <= result.positions[index - 1]) {
      throw new Error(`${screen}: result beat order is ${result.positions.join(' -> ')}`);
    }
  }
}

async function assertNoPreChoiceLeaks(screen) {
  const leaks = await evaluate(`(() => {
    const root = document.querySelector('.${screen}');
    if (!root) return ['missing screen'];
    const text = root.innerText || '';
    const found = [];
    if (/\\bd20\\b/i.test(text)) found.push('d20 target or check label');
    if (/成功率/.test(text)) found.push('exact success rate');
    if (root.querySelector('.result-text, .outcome-stamp, .d20-value')) found.push('result body');
    return found;
  })()`);
  if (leaks.length) throw new Error(`${screen}: pre-choice leak: ${leaks.join(', ')}`);
}

async function currentScreen() {
  return evaluate(`(() => {
    for (const name of ${JSON.stringify(SCREENS)}) {
      if (document.querySelector('.' + name)) return name;
    }
    return null;
  })()`);
}

async function waitForScreen(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const screen = await currentScreen();
    if (screen) return screen;
    await sleep(120);
  }
  return null;
}

async function waitForScreenChange(previous, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const screen = await currentScreen();
    if (screen && screen !== previous) return screen;
    await sleep(120);
  }
  return null;
}

async function assertNoOverflow(screen) {
  const overflow = await evaluate(`Math.max(0, document.documentElement.scrollWidth - window.innerWidth)`);
  if (overflow > 1) throw new Error(`${screen}: horizontal overflow ${overflow}px`);
}

async function assertVisibleImages(screen) {
  const loaded = await waitFor(`Array.from(document.images).every((image) => image.complete)`, 8000);
  if (!loaded) throw new Error(`${screen}: images did not finish loading`);
  const broken = await evaluate(`Array.from(document.images).filter((image) => image.naturalWidth === 0).map((image) => image.getAttribute('src'))`);
  if (broken.length) throw new Error(`${screen}: broken images: ${broken.slice(0, 3).join(', ')}`);
}

async function clearStorage() {
  const origin = new URL(TARGET).origin;
  await send("Storage.clearDataForOrigin", { origin, storageTypes: "all" });
}

async function playToRebirth() {
  let screen = await waitForScreen();
  if (!screen) throw new Error("no screen rendered after navigation");
  let sawTimeExplanation = false;
  let sawTimeBeats = false;
  let visitedStudyDao = false;
  const screenTrace = [];
  const choiceTextScreens = new Set();
  const requiredChoiceScreens = ["soul_test", "study_dao"];
  const hasRequiredChoiceCoverage = () =>
    requiredChoiceScreens.every((required) => choiceTextScreens.has(required)) &&
    (choiceTextScreens.has("event_guide") || choiceTextScreens.has("event_later"));

  for (let step = 0; step < 200; step += 1) {
    screenTrace.push(screen);
    if (screenTrace.length > 80) screenTrace.shift();
    await assertNoOverflow(screen);
    await assertVisibleImages(screen);
    if (["event_guide", "event_later", "fate_window", "karma_knock", "study_dao"].includes(screen)) {
      await assertNoPreChoiceLeaks(screen);
    }
    if (screen !== "event_guide" && screen !== "event_later") {
      const choiceTextCount = await assertChoiceRowText(screen, { minCount: screen === "study_dao" ? 1 : 0 });
      if (choiceTextCount > 0) choiceTextScreens.add(screen);
    }

    if (screen === "home") {
      const title = await evaluate(`document.querySelector('.home-title')?.textContent || ''`);
      if (!title.trim()) throw new Error("home title missing");
      await clickHomePrimary("魂性问心");
    } else if (screen === "soul_test") {
      const question = await evaluate(`document.querySelector('.soul_test .screen-copy')?.textContent?.trim() || ''`);
      if (!question) throw new Error("soul test question missing");
      await clickFirst(".soul_test .choice-row", "soul test answer");
      const advanced = await waitFor(
        `(() => {
          const text = document.querySelector('.soul_test .screen-copy')?.textContent?.trim() || '';
          return text !== ${JSON.stringify(question)} || !!document.querySelector('.role_pick');
        })()`,
        1500
      );
      if (!advanced) throw new Error("soul test did not advance after answer");
      const next = await currentScreen();
      if (next === "soul_test") continue;
      if (!next) throw new Error("soul test did not render the next screen");
      screen = next;
      continue;
    } else if (screen === "role_pick") {
      await assertChoiceRowText(screen, { selector: ".role_pick .role-card .primary-btn", labelSelector: ".button-label", minCount: 1 });
      await clickFirst(".role_pick .role-card .primary-btn", "choose starting role");
    } else if (screen === "event_guide" || screen === "event_later") {
      await assertChoiceList(screen);
      const choiceTextCount = await assertChoiceRowText(screen, { minCount: 3 });
      if (choiceTextCount > 0) choiceTextScreens.add(screen);
      if (!visitedStudyDao) {
        await clickFirst(".event-menu button:nth-child(2)", "open dao study");
        const studyScreen = await waitForScreenChange(screen);
        if (studyScreen !== "study_dao") throw new Error(`dao study did not open: ${studyScreen || "no screen change"}`);
        visitedStudyDao = true;
        screen = studyScreen;
        continue;
      }
      await clickFirst(".event-choice", "first event option");
      await waitFor(`!!document.querySelector('.modal-overlay') || !document.querySelector('.${screen}')`, 1000);
      if (await evaluate(`!!document.querySelector('.modal-overlay')`)) {
        await clickFirst(".modal-actions .primary-btn", "sacrifice confirm");
      }
    } else if (screen === "d20_result") {
      await clickFirst(".d20_result .continue-btn", "d20 continue");
    } else if (screen === "result_beat") {
      if (await assertTimeExplanation(screen)) throw new Error("result_beat: time ledger rendered before result continue");
      await assertResultBeatOrder(screen);
      await clickFirst(".result_beat .result-continue", "result continue");
    } else if (screen === "continuation") {
      if (await assertTimeExplanation(screen)) sawTimeExplanation = true;
      if (await assertTimeBeats(screen)) sawTimeBeats = true;
      await clickFirst(".continuation .continuation-next", "continuation continue");
    } else if (screen === "interlude") {
      await clickFirst(".interlude .primary-btn", "interlude continue");
    } else if (screen === "fate_window") {
      await clickFirst(".fate_window .choice-row:last-child", "avoid fate window and schedule karma");
    } else if (screen === "karma_knock") {
      await clickFirst(".karma_knock .choice-row", "break karma");
    } else if (screen === "study_dao") {
      await clickFirst(".study_dao .content-column > .ghost-btn", "return from dao study");
      const next = await waitForScreenChange(screen);
      if (!next) throw new Error("dao study did not return to the current event");
      screen = next;
      continue;
    } else if (screen === "cliff") {
      await clickFirst(".cliff .ghost-btn", "enter rebirth");
    } else if (screen === "rebirth") {
      const allocRows = await evaluate(`document.querySelectorAll('.rebirth .alloc-row').length`);
      if (allocRows !== 4) throw new Error(`rebirth: expected 4 allocation rows, got ${allocRows}`);
      const score = await evaluate(`Number(document.querySelector('.rebirth .score-value')?.textContent || -1)`);
      if (!(score >= 0 && score <= 1000)) throw new Error(`rebirth: invalid score ${score}`);
      await assertRebirthAllocationControls();
      await clickFirst(".rebirth-actions .primary-btn", "confirm rebirth");
    } else if (screen === "birth_pick") {
      await assertChoiceRowText(screen, { selector: ".birth_pick .birth-card .primary-btn", labelSelector: ".button-label", minCount: 1 });
      await clickFirst(".birth_pick .birth-card .primary-btn", "choose birth");
      const next = await waitForScreenChange(screen);
      if (!next) throw new Error("birth choice did not start a new life");
      screen = next;
      if (!sawTimeExplanation) throw new Error("full run did not render an explained time advance");
      if (!sawTimeBeats) throw new Error("full run did not render structured time beats");
      if (!hasRequiredChoiceCoverage()) {
        throw new Error(`first-life mobile flow missed required coverage: ${[...choiceTextScreens].sort().join(', ') || '(none)'}`);
      }
      const coveredChoiceScreens = [...choiceTextScreens].sort();
      return { screen, steps: step + 1, coveredChoiceScreens };
    } else if (screen === "cycle_recap") {
      throw new Error("cycle recap reached before the two-life mobile smoke boundary");
    } else {
      throw new Error(`unexpected screen: ${screen}`);
    }

    const next = await waitForScreenChange(screen);
    if (!next) throw new Error(`${screen}: screen did not change after interaction`);
    screen = next;
  }

  throw new Error(`mobile smoke did not reach rebirth; recent screens: ${screenTrace.join(" -> ")}`);
}

async function verifyHistory() {
  await send("Page.navigate", { url: TARGET });
  if (!(await waitFor(`!!document.querySelector('.home-title')`))) throw new Error("home did not render for history check");
  await clickHomePrimary("再入一世");
  const replayScreen = await waitForScreenChange("home");
  if (!["event_guide", "event_later", "rebirth", "birth_pick"].includes(replayScreen)) {
    throw new Error(`home replay CTA did not enter the active cycle: ${replayScreen || "stayed on home"}`);
  }
  if (replayScreen === "event_guide" || replayScreen === "event_later") await assertChoiceList(replayScreen);
  await send("Page.navigate", { url: TARGET });
  if (!(await waitFor(`!!document.querySelector('.home-title')`))) throw new Error("home did not render before history check");
  await clickFirst(".home-nav button:last-child", "open history");
  if (!(await waitFor(`!!document.querySelector('.history')`))) throw new Error("history screen did not render");
  const rows = await evaluate(`document.querySelectorAll('.history-row-card').length`);
  if (rows < 1) throw new Error("completed run was not persisted to history");
  await assertNoOverflow("history");
  return { rows, replayScreen };
}

async function runViewport(width, height) {
  console.log(`run viewport: ${width}x${height}`);
  emulatedMobile = width < 600;
  eventChoicePaintChecked = false;
  await send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: emulatedMobile ? 3 : 1,
    mobile: emulatedMobile
  });
  await clearStorage();
  await send("Page.navigate", { url: TARGET });

  if (!(await waitFor(`window.innerWidth === ${width} && window.innerHeight === ${height}`))) {
    throw new Error(`viewport not applied: expected ${width}x${height}`);
  }
  const started = await playToRebirth();
  const history = await verifyHistory();
  return { viewport: `${width}x${height}`, ...started, historyRows: history.rows, replayScreen: history.replayScreen };
}

async function connect(port) {
  let pageUrl;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
      const page = list.find((target) => target.type === "page");
      if (page) {
        pageUrl = page.webSocketDebuggerUrl;
        break;
      }
    } catch {}
    await sleep(100);
  }
  if (!pageUrl) {
    console.error("no page target", stderr.slice(0, 500));
    process.exit(3);
  }

  socket = new WebSocket(pageUrl);
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const handler = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) handler.reject(new Error(JSON.stringify(message.error)));
      else handler.resolve(message.result);
      return;
    }
    if (message.method === "Runtime.exceptionThrown") jsErrors.push(message.params.exceptionDetails);
  };
  socket.onopen = async () => {
    try {
      connected = true;
      await send("Page.enable");
      await send("Runtime.enable");
      const results = [];
      for (const viewport of VIEWPORTS) {
        results.push(await runViewport(viewport[0], viewport[1]));
      }
      if (jsErrors.length) {
        const first = jsErrors[0];
        throw new Error(`page JS exception: ${first.exception?.description || first.text}`);
      }
      console.log(JSON.stringify(results, null, 2));
      console.log(`layout ok: primary CTA -> soul test -> role -> required event/dao choice text + optional fate/karma coverage + result order/time beats explained -> first rebirth -> replay CTA -> history (${VIEWPORT_LABEL})`);
      chrome.kill();
      process.exit(0);
    } catch (error) {
      console.error("mobile layout failed:", error.message);
      try {
        const dump = await evaluate(`JSON.stringify({ readyState: document.readyState, screen: document.querySelector('.screen')?.className || null, body: document.body?.innerText?.slice(0, 240) })`);
        console.error("PAGE_DUMP", dump);
      } catch {}
      for (const details of jsErrors.slice(-5)) {
        console.error("JS_EXCEPTION", details.exception?.description || details.text, details.url, details.lineNumber, details.columnNumber);
      }
      console.error("stderr:", stderr.slice(-700));
      chrome.kill();
      process.exit(1);
    }
  };
  socket.onerror = (error) => {
    console.error("ws error", error.message || String(error));
    chrome.kill();
    process.exit(1);
  };
}

setTimeout(() => {
  console.error("timeout", stderr.slice(0, 700));
  chrome.kill();
  process.exit(2);
}, 180000);
