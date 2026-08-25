import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME_BIN || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const TARGET = process.env.CDP_URL || "http://127.0.0.1:8000/";

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
    "--disable-gpu",
    "--disable-software-rasterizer",
    "--mute-audio",
    "--remote-debugging-port=0",
    `--user-data-dir=${join(tmpdir(), `cdp-layout-${Date.now()}`)}`,
    "about:blank"
  ],
  { stdio: ["ignore", "ignore", "pipe"] }
);

let stderr = "";
chrome.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
  const match = stderr.match(/DevTools listening on ws:\/\/[^\s]+:(\d+)\//);
  if (match) connect(Number(match[1]));
});

let socket;
let nextId = 1;
const pending = new Map();
let connected = false;
const jsErrors = [];

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    const trySend = () => {
      if (!connected || socket.readyState !== 1) {
        reject(new Error("socket not connected"));
        return;
      }
      socket.send(JSON.stringify({ id, method, params }));
    };
    if (connected && socket.readyState === 1) trySend();
    else {
      const timer = setInterval(() => {
        if (connected && socket.readyState === 1) {
          clearInterval(timer);
          trySend();
        }
      }, 20);
      setTimeout(() => clearInterval(timer), 5000);
    }
  });
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  if (!result || !result.result) {
    throw new Error(`evaluate no result: ${JSON.stringify(result)}`);
  }
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text);
  }
  return result.result && result.result.value;
}

async function waitFor(expression, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return true;
    await sleep(150);
  }
  return false;
}

function rectInfo(selector) {
  return `(() => {
    const n = document.querySelector(${JSON.stringify(selector)});
    if (!n) return null;
    const r = n.getBoundingClientRect();
    return JSON.stringify({ width: Math.round(r.width), height: Math.round(r.height), left: Math.round(r.left), right: Math.round(r.right) });
  })()`;
}

async function assertNoOverflow() {
  const overflow = await evaluate(`document.documentElement.scrollWidth - window.innerWidth`);
  if (overflow > 0) {
    throw new Error(`horizontal overflow ${overflow}px`);
  }
}

async function runViewport(width, height) {
  await send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 3,
    mobile: true
  });
  await send("Page.navigate", { url: TARGET });
  await sleep(500);
  const applied = await evaluate(`JSON.stringify({ w: window.innerWidth, h: window.innerHeight })`);
  const { w, h } = JSON.parse(applied);
  if (w !== width || h !== height) {
    throw new Error(`viewport not applied: got ${w}x${h}, want ${width}x${height}`);
  }
  await sleep(500);

  if (!(await waitFor(`!!document.querySelector('.home-title')`))) {
    throw new Error("home did not render");
  }
  const homeTitle = JSON.parse(await evaluate(rectInfo(".home-title")));
  const start = JSON.parse(await evaluate(rectInfo(".primary-btn")));
  if (!homeTitle || !start) throw new Error("home controls missing");
  await assertNoOverflow();

  await evaluate(`document.querySelector('.primary-btn').click(); true`);
  if (!(await waitFor(`!!document.querySelector('.event-screen')`))) {
    throw new Error("event did not render");
  }
  const option = JSON.parse(await evaluate(rectInfo(".option-btn")));
  const title = JSON.parse(await evaluate(rectInfo(".event-title")));
  if (!option || !title) throw new Error("event controls missing");
  if (option.height < 44) throw new Error(`option tap target too small: ${option.height}px`);
  await assertNoOverflow();

  await evaluate(`document.querySelector('.option-btn').click(); true`);
  if (!(await waitFor(`document.querySelectorAll('.stat-value').length === 6`))) {
    throw new Error("stat grid missing");
  }
  await assertNoOverflow();

  let steps = 0;
  while (steps < 40) {
    steps++;
    let s;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const state = await evaluate(`JSON.stringify({
        event: !!document.querySelector('.event-screen'),
        interlude: !!document.querySelector('.interlude'),
        ending: !!document.querySelector('.ending-screen')
      })`);
      s = JSON.parse(state);
      if (s.event || s.interlude || s.ending) break;
      await sleep(150);
    }
    if (!s || (!s.event && !s.interlude && !s.ending)) {
      throw new Error(`no screen after step ${steps}`);
    }
    if (s.ending) break;
    if (s.interlude) {
      await evaluate(`document.querySelector('.interlude .primary-btn').click(); true`);
    } else if (s.event) {
      await evaluate(`document.querySelector('.option-btn').click(); true`);
    }
    await sleep(500);
  }
  if (!(await waitFor(`!!document.querySelector('.ending-title')`, 6000))) {
    throw new Error("ending did not render");
  }
  const endingTitle = JSON.parse(await evaluate(rectInfo(".ending-title")));
  const endingAction = JSON.parse(await evaluate(rectInfo(".ending-actions .primary-btn")));
  if (!endingTitle || !endingAction) throw new Error("ending controls missing");
  if (endingAction.height < 44) throw new Error(`ending action too small: ${endingAction.height}px`);
  await assertNoOverflow();

  await evaluate(`Array.from(document.querySelectorAll('.ending-actions button')).find((b) => b.textContent.includes('返回首页'))?.click(); true`);
  await sleep(500);
  if (!(await waitFor(`!!document.querySelector('.home-title')`))) {
    throw new Error("home did not return after ending");
  }
  const historyRows = await evaluate(`document.querySelectorAll('.history-row').length`);
  if (historyRows < 1) throw new Error("history did not persist after ending");
  await assertNoOverflow();

  return {
    viewport: `${width}x${height}`,
    homeTitle: homeTitle,
    startButton: start,
    eventTitle: title,
    optionButton: option,
    endingTitle: endingTitle,
    endingAction: endingAction,
    historyRows
  };
}

async function connect(port) {
  let pageUrl;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      const page = list.find((target) => target.type === "page");
      if (page) {
        pageUrl = page.webSocketDebuggerUrl;
        break;
      }
    } catch {}
    await sleep(100);
  }
  if (!pageUrl) {
    console.error("no page target", stderr.slice(0, 400));
    process.exit(3);
  }
  socket = new WebSocket(pageUrl);
  connected = false;
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
      return;
    }
    if (message.method === "Runtime.exceptionThrown") {
      const details = message.params.exceptionDetails;
      jsErrors.push(details);
    }
  };
  socket.onopen = async () => {
    try {
      connected = true;
      await send("Page.enable");
      await send("Runtime.enable");
      const results = [];
      for (const vp of [
        [375, 667],
        [390, 844]
      ]) {
        const summary = await runViewport(vp[0], vp[1]);
        results.push(summary);
        console.log(`viewport ok: ${summary.viewport}`);
      }
      console.log(JSON.stringify(results, null, 2));
      console.log("mobile layout ok: 375x667, 390x844");
      process.exit(0);
    } catch (error) {
      console.error("mobile layout failed:", error.message);
      try {
        const dump = await evaluate(`JSON.stringify({ readyState: document.readyState, body: document.body?.innerText?.slice(0, 200), html: document.documentElement.outerHTML.slice(0, 300) })`);
        console.error("PAGE_DUMP", dump);
      } catch {}
      for (const details of jsErrors.slice(-6)) {
        console.error("JS_EXCEPTION", details.exception?.description || details.text, details.url, details.lineNumber, details.columnNumber);
      }
      console.error("stderr:", stderr.slice(-500));
      process.exit(1);
    }
  };
  socket.onerror = (error) => {
    console.error("ws error", error.message || String(error));
    process.exit(1);
  };
}

setTimeout(() => {
  console.error("timeout", stderr.slice(0, 600));
  process.exit(2);
}, 90000);
