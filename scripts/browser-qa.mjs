import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import net from "node:net";

const BASE_URL = (process.env.BASE_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const QA_EMAIL = process.env.QA_EMAIL || "";
const QA_PASSWORD = process.env.QA_PASSWORD || "";
const PUBLIC_ONLY = process.env.PUBLIC_ONLY === "true";
const OUT_DIR = resolve(process.env.OUT_DIR || "qa-artifacts/browser");
const CHROME_PATH = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const COMMAND_TIMEOUT_MS = 15_000;
const PAGE_TIMEOUT_MS = 20_000;

if (!PUBLIC_ONLY && (!QA_EMAIL || !QA_PASSWORD)) {
  console.error("QA_EMAIL and QA_PASSWORD are required.");
  process.exit(2);
}

if (typeof WebSocket === "undefined") {
  console.error("This script requires Node.js 22+ with the global WebSocket API.");
  process.exit(2);
}

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

async function getFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

class CdpClient {
  constructor(webSocketUrl) {
    this.webSocketUrl = webSocketUrl;
    this.socket = null;
    this.sequence = 0;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async connect() {
    await new Promise((resolveConnect, reject) => {
      const socket = new WebSocket(this.webSocketUrl);
      this.socket = socket;
      const timeout = setTimeout(() => reject(new Error("Timed out connecting to Chrome DevTools.")), COMMAND_TIMEOUT_MS);
      socket.addEventListener("open", () => {
        clearTimeout(timeout);
        resolveConnect();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("Chrome DevTools WebSocket connection failed."));
      }, { once: true });
      socket.addEventListener("message", (event) => this.handleMessage(event.data));
      socket.addEventListener("close", () => {
        for (const { reject: rejectPending, timer } of this.pending.values()) {
          clearTimeout(timer);
          rejectPending(new Error("Chrome DevTools connection closed."));
        }
        this.pending.clear();
      });
    });
  }

  handleMessage(raw) {
    const message = JSON.parse(String(raw));
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result);
      return;
    }
    const callbacks = this.listeners.get(message.method) || [];
    for (const callback of callbacks) callback(message.params || {});
  }

  on(method, callback) {
    const callbacks = this.listeners.get(method) || [];
    callbacks.push(callback);
    this.listeners.set(method, callbacks);
  }

  send(method, params = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Chrome DevTools is not connected."));
    }
    const id = ++this.sequence;
    return new Promise((resolveCommand, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${COMMAND_TIMEOUT_MS}ms.`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolveCommand, reject, timer, method });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket?.close();
  }
}

async function waitForChrome(port, processHandle) {
  const deadline = Date.now() + PAGE_TIMEOUT_MS;
  let lastError;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      throw new Error(`Chrome exited before DevTools became available (exit ${processHandle.exitCode}).`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const target = targets.find((candidate) => candidate.type === "page" && candidate.webSocketDebuggerUrl);
        if (target) return target.webSocketDebuggerUrl;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(150);
  }
  throw new Error(`Chrome DevTools did not start: ${lastError instanceof Error ? lastError.message : "timeout"}`);
}

async function evaluate(client, fn, argument) {
  const expression = `(${fn.toString()})(${JSON.stringify(argument)})`;
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    const description = result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Evaluation failed";
    throw new Error(description);
  }
  return result.result?.value;
}

async function waitFor(client, description, fn, argument, timeout = PAGE_TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(client, fn, argument)) return;
    } catch (error) {
      lastError = error;
    }
    await delay(120);
  }
  const bodyText = await evaluate(client, () => document.body?.innerText?.slice(0, 900) || "", null).catch(() => "");
  throw new Error(`Timed out waiting for ${description}.${lastError ? ` ${lastError.message}` : ""}\nVisible page text:\n${bodyText}`);
}

async function setInput(client, name, value) {
  const changed = await evaluate(client, ({ inputName, inputValue }) => {
    const input = document.querySelector(`[name="${CSS.escape(inputName)}"]`);
    if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement || input instanceof HTMLSelectElement)) return false;
    const prototype = input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : input instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    descriptor?.set?.call(input, inputValue);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, { inputName: name, inputValue: value });
  if (!changed) throw new Error(`Could not find form field named ${name}.`);
}

async function clickNamed(client, names) {
  const clicked = await evaluate(client, (candidateNames) => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rectangle = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 && rectangle.width > 0 && rectangle.height > 0;
    };
    const accessibleName = (element) => {
      const labelledBy = element.getAttribute("aria-labelledby");
      const labelledText = labelledBy
        ? labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ")
        : "";
      return (element.getAttribute("aria-label") || labelledText || element.textContent || element.getAttribute("title") || "")
        .replace(/\s+/g, " ")
        .trim();
    };
    const controls = Array.from(document.querySelectorAll("button, a[href], [role=button]")).filter(visible);
    for (const name of candidateNames) {
      const exact = controls.find((element) => accessibleName(element).toLowerCase() === name.toLowerCase());
      const partial = controls.find((element) => accessibleName(element).toLowerCase().includes(name.toLowerCase()));
      const target = exact || partial;
      if (target instanceof HTMLElement) {
        target.click();
        return { clicked: true, name: accessibleName(target) };
      }
    }
    return { clicked: false, available: controls.map(accessibleName).filter(Boolean).slice(0, 80) };
  }, Array.isArray(names) ? names : [names]);
  if (!clicked?.clicked) {
    throw new Error(`Could not find visible control named ${JSON.stringify(names)}. Available: ${(clicked?.available || []).join(", ")}`);
  }
  return clicked.name;
}

async function waitForSettledUi(client) {
  await delay(550);
  await evaluate(client, async () => {
    if (document.fonts?.ready) await Promise.race([document.fonts.ready, new Promise((resolveFont) => setTimeout(resolveFont, 1_500))]);
    await new Promise((resolveFrames) => requestAnimationFrame(() => requestAnimationFrame(resolveFrames)));
    return true;
  }, null);
}

async function screenshot(client, filename) {
  const result = await client.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  const destination = join(OUT_DIR, filename);
  await writeFile(destination, Buffer.from(result.data, "base64"));
  return destination;
}

async function auditCurrentView(client, viewport, pageName, screenshotName) {
  await waitForSettledUi(client);
  const audit = await evaluate(client, ({ expectedWidth, currentPage }) => {
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element);
      const rectangle = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 && rectangle.width > 0 && rectangle.height > 0;
    };
    const selector = (element) => {
      const parts = [];
      let current = element;
      while (current && current !== document.body && parts.length < 4) {
        let part = current.tagName.toLowerCase();
        if (current.id) {
          part += `#${current.id}`;
          parts.unshift(part);
          break;
        }
        if (current.classList.length) part += `.${Array.from(current.classList).slice(0, 2).join(".")}`;
        parts.unshift(part);
        current = current.parentElement;
      }
      return parts.join(" > ");
    };
    const labelledByText = (element) => {
      const labelledBy = element.getAttribute("aria-labelledby");
      return labelledBy
        ? labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ").trim()
        : "";
    };
    const accessibleName = (element) => {
      const aria = element.getAttribute("aria-label")?.trim() || labelledByText(element);
      if (aria) return aria;
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
        const labels = Array.from(element.labels || []).map((label) => label.textContent || "").join(" ").replace(/\s+/g, " ").trim();
        return labels || element.getAttribute("title")?.trim() || "";
      }
      return (element.textContent || element.getAttribute("title") || "").replace(/\s+/g, " ").trim();
    };

    const controls = Array.from(document.querySelectorAll("button, input:not([type=hidden]), select, textarea")).filter(visible);
    const unlabeled = controls
      .filter((element) => !accessibleName(element))
      .map((element) => ({ selector: selector(element), tag: element.tagName.toLowerCase(), type: element.getAttribute("type") || null }));

    const zoomRiskControls = expectedWidth <= 820
      ? controls
        .filter((element) => element instanceof HTMLSelectElement
          || element instanceof HTMLTextAreaElement
          || (element instanceof HTMLInputElement && !["hidden", "checkbox", "radio", "range", "color", "file", "button", "submit", "reset"].includes(element.type)))
        .map((element) => ({
          selector: selector(element),
          name: accessibleName(element).slice(0, 100),
          fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
        }))
        .filter(({ fontSize }) => fontSize < 16)
      : [];

    const primarySelector = [
      "button.button",
      "button[type=submit]",
      "nav button",
      ".balance-card__actions button",
      ".page-title__actions button",
      ".sheet__footer button",
    ].join(",");
    const undersized = Array.from(document.querySelectorAll(primarySelector))
      .filter(visible)
      .map((element) => {
        const rectangle = element.getBoundingClientRect();
        return {
          selector: selector(element),
          name: accessibleName(element).slice(0, 100),
          width: Math.round(rectangle.width * 10) / 10,
          height: Math.round(rectangle.height * 10) / 10,
        };
      })
      .filter(({ width, height }) => width < 44 || height < 44);

    const root = document.documentElement;
    const body = document.body;
    const clientWidth = root.clientWidth;
    const scrollWidth = Math.max(root.scrollWidth, body?.scrollWidth || 0);
    const overflowing = Array.from(document.querySelectorAll("body *"))
      .filter((element) => visible(element) && element.getBoundingClientRect().right > clientWidth + 1)
      .slice(0, 12)
      .map((element) => ({ selector: selector(element), right: Math.round(element.getBoundingClientRect().right * 10) / 10 }));

    return {
      page: currentPage,
      title: document.title,
      viewport: { expectedWidth, innerWidth: window.innerWidth, innerHeight: window.innerHeight },
      documentSize: { clientWidth, scrollWidth, scrollHeight: Math.max(root.scrollHeight, body?.scrollHeight || 0) },
      horizontalOverflow: scrollWidth > clientWidth + 1,
      overflowing,
      unlabeled,
      undersized,
      zoomRiskControls,
    };
  }, { expectedWidth: viewport.width, currentPage: pageName });
  audit.screenshot = await screenshot(client, screenshotName);
  return audit;
}

function normaliseException(params) {
  return {
    text: params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || "Uncaught exception",
    url: params.exceptionDetails?.url || "",
    line: params.exceptionDetails?.lineNumber ?? null,
    column: params.exceptionDetails?.columnNumber ?? null,
  };
}

async function launchChrome(viewport, label) {
  const port = await getFreePort();
  const profileDirectory = await mkdtemp(join(tmpdir(), `pennyquill-browser-qa-${label}-`));
  const args = [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDirectory}`,
    "--remote-allow-origins=*",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--disable-features=Translate,MediaRouter",
    `--window-size=${viewport.width},${viewport.height}`,
    BASE_URL,
  ];
  const processHandle = spawn(CHROME_PATH, args, { stdio: "ignore", windowsHide: true });
  processHandle.unref();
  const webSocketUrl = await waitForChrome(port, processHandle);
  return { processHandle, profileDirectory, webSocketUrl };
}

async function runViewport(viewport) {
  const { processHandle, profileDirectory, webSocketUrl } = await launchChrome(viewport, viewport.label);
  const client = new CdpClient(webSocketUrl);
  const runtimeExceptions = [];
  const consoleErrors = [];
  const failedResponses = [];
  const loadingFailures = [];
  const requests = new Map();
  const audits = [];

  try {
    await client.connect();
    client.on("Runtime.exceptionThrown", (params) => runtimeExceptions.push(normaliseException(params)));
    client.on("Runtime.consoleAPICalled", (params) => {
      if (params.type !== "error" && params.type !== "assert") return;
      consoleErrors.push({
        type: params.type,
        text: (params.args || []).map((argument) => argument.value ?? argument.description ?? "").join(" "),
      });
    });
    client.on("Network.requestWillBeSent", (params) => requests.set(params.requestId, params.request?.url || ""));
    client.on("Network.responseReceived", (params) => {
      if ((params.response?.status || 0) >= 400) {
        failedResponses.push({ status: params.response.status, url: params.response.url, type: params.type });
      }
    });
    client.on("Network.loadingFailed", (params) => {
      const url = requests.get(params.requestId) || "";
      if (!params.canceled) loadingFailures.push({ url, errorText: params.errorText, blockedReason: params.blockedReason || null });
    });

    await Promise.all([
      client.send("Page.enable"),
      client.send("Runtime.enable"),
      client.send("Network.enable"),
      client.send("Log.enable"),
    ]);
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.deviceScaleFactor,
      mobile: viewport.mobile,
      screenWidth: viewport.width,
      screenHeight: viewport.height,
    });
    await client.send("Emulation.setTouchEmulationEnabled", { enabled: viewport.mobile, maxTouchPoints: viewport.mobile ? 5 : 1 });
    await client.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await client.send("Page.navigate", { url: BASE_URL });
    await waitFor(client, "the sign-in form", () => Boolean(document.querySelector('input[name="email"]') && document.querySelector('input[name="password"]')), null);
    if (PUBLIC_ONLY) {
      await waitForSettledUi(client);
      audits.push(await auditCurrentView(client, viewport, "Sign in", `${viewport.label}-sign-in.png`));
      for (let index = failedResponses.length - 1; index >= 0; index -= 1) {
        const failure = failedResponses[index];
        if (failure.status === 401 && new URL(failure.url).pathname === "/api/auth/me") failedResponses.splice(index, 1);
      }
      return {
        viewport,
        login: "skipped-public-only",
        audits,
        runtimeExceptions,
        consoleErrors,
        failedResponses,
        loadingFailures,
        apiFailures: failedResponses.filter(({ url }) => url.includes("/api/")),
        apiLoadingFailures: loadingFailures.filter(({ url }) => url.includes("/api/")),
      };
    }
    await setInput(client, "email", QA_EMAIL);
    await setInput(client, "password", QA_PASSWORD);
    await clickNamed(client, ["Sign in"]);
    await waitFor(client, "the authenticated application shell", () => Boolean(document.querySelector(".app-shell")), null);
    await waitForSettledUi(client);

    // Ignore only the expected unauthenticated session probe made during application boot.
    // Keep every console, runtime, resource and API failure observed on the sign-in page.
    for (let index = failedResponses.length - 1; index >= 0; index -= 1) {
      const failure = failedResponses[index];
      if (failure.status === 401 && new URL(failure.url).pathname === "/api/auth/me") {
        failedResponses.splice(index, 1);
      }
    }

    async function visit(pageName) {
      if (pageName === "Settings" && viewport.mobile) {
        await clickNamed(client, ["Home"]);
        await waitFor(client, "Home dashboard", () => Boolean(document.querySelector(".balance-card")), null);
        await clickNamed(client, ["Open settings and your profile"]);
      } else {
        await clickNamed(client, [pageName]);
      }
      if (pageName === "Home") {
        await waitFor(client, "Home dashboard", () => Boolean(document.querySelector(".balance-card")), null);
      } else {
        await waitFor(client, `${pageName} page`, (expected) => Array.from(document.querySelectorAll("h1")).some((heading) => heading.textContent?.trim() === expected), pageName);
      }
      audits.push(await auditCurrentView(client, viewport, pageName, `${viewport.label}-${pageName.toLowerCase()}.png`));
    }

    for (const pageName of ["Home", "Activity", "Analytics", "Plan", "Settings"]) {
      await visit(pageName);
    }

    await visit("Home");
    await clickNamed(client, ["Add expense", "Add transaction"]);
    await waitFor(client, "the add transaction sheet", () => Boolean(document.querySelector('[role="dialog"]')), null);
    audits.push(await auditCurrentView(client, viewport, "Add transaction sheet", `${viewport.label}-add-transaction-sheet.png`));
    await clickNamed(client, ["Close"]);
    await waitFor(client, "the add transaction sheet to close", () => !document.querySelector('[role="dialog"]'), null);

    await clickNamed(client, ["Import SMS", "Import message"]);
    await waitFor(client, "the SMS import sheet", () => Boolean(document.querySelector('[role="dialog"]')), null);
    audits.push(await auditCurrentView(client, viewport, "SMS import sheet", `${viewport.label}-sms-import-sheet.png`));
    await clickNamed(client, ["Close"]);
    await waitFor(client, "the SMS import sheet to close", () => !document.querySelector('[role="dialog"]'), null);
    await waitForSettledUi(client);

    const apiFailures = failedResponses.filter(({ url }) => url.includes("/api/"));
    const apiLoadingFailures = loadingFailures.filter(({ url }) => url.includes("/api/"));
    return {
      viewport,
      login: "passed",
      audits,
      runtimeExceptions,
      consoleErrors,
      failedResponses,
      loadingFailures,
      apiFailures,
      apiLoadingFailures,
    };
  } finally {
    await Promise.race([
      client.send("Browser.close").catch(() => undefined),
      delay(1_000),
    ]).catch(() => undefined);
    client.close();
    if (processHandle.exitCode === null) processHandle.kill();
    await rm(profileDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const healthResponse = await fetch(BASE_URL, { redirect: "follow" }).catch((error) => {
    throw new Error(`Cannot reach ${BASE_URL}: ${error.message}`);
  });
  if (!healthResponse.ok) throw new Error(`${BASE_URL} returned HTTP ${healthResponse.status}.`);

  const viewports = [
    { label: "mobile", width: 390, height: 844, deviceScaleFactor: 1, mobile: true },
    { label: "desktop", width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false },
  ];
  const results = [];
  for (const viewport of viewports) {
    console.log(`Running ${viewport.label} QA (${viewport.width}x${viewport.height})...`);
    results.push(await runViewport(viewport));
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    qaEmail: QA_EMAIL,
    screenshots: results.flatMap((result) => result.audits.map((audit) => audit.screenshot)),
    totals: {
      views: results.reduce((total, result) => total + result.audits.length, 0),
      runtimeExceptions: results.reduce((total, result) => total + result.runtimeExceptions.length, 0),
      consoleErrors: results.reduce((total, result) => total + result.consoleErrors.length, 0),
      failedApiResponses: results.reduce((total, result) => total + result.apiFailures.length + result.apiLoadingFailures.length, 0),
      failedNetworkResponses: results.reduce((total, result) => total + result.failedResponses.length + result.loadingFailures.length, 0),
      horizontalOverflows: results.reduce((total, result) => total + result.audits.filter((audit) => audit.horizontalOverflow).length, 0),
      unlabeledControls: results.reduce((total, result) => total + result.audits.reduce((count, audit) => count + audit.unlabeled.length, 0), 0),
      undersizedPrimaryControls: results.reduce((total, result) => total + result.audits.reduce((count, audit) => count + audit.undersized.length, 0), 0),
      mobileZoomRiskControls: results.reduce((total, result) => total + result.audits.reduce((count, audit) => count + audit.zoomRiskControls.length, 0), 0),
    },
    results,
  };
  const reportPath = join(OUT_DIR, "browser-qa-report.json");
  await writeFile(reportPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  console.log(JSON.stringify(summary.totals, null, 2));
  console.log(`Report: ${reportPath}`);
  const hardFailureCount = summary.totals.runtimeExceptions
    + summary.totals.consoleErrors
    + summary.totals.failedApiResponses
    + summary.totals.horizontalOverflows
    + summary.totals.unlabeledControls
    + summary.totals.mobileZoomRiskControls;
  if (hardFailureCount > 0) {
    console.error(`Browser QA failed with ${hardFailureCount} blocking issue(s).`);
    process.exit(1);
  } else {
    console.log("Browser QA passed all blocking checks.");
    process.exit(0);
  }
}

main().catch(async (error) => {
  await mkdir(OUT_DIR, { recursive: true }).catch(() => undefined);
  await writeFile(join(OUT_DIR, "browser-qa-fatal.txt"), `${error.stack || error.message || String(error)}\n`, "utf8").catch(() => undefined);
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
