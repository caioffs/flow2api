// Flow2API Companion
//
// One service worker for the two jobs the browser has to do for Flow2API:
//   1. keep the Google session fresh   (chrome.cookies -> POST /api/plugin/update-token)
//   2. mint reCAPTCHA tokens           (WebSocket /captcha_ws -> trusted execute)
//
// Both talk to the same server with the same API key.

const DEFAULT_SETTINGS = {
    serverBase: "http://127.0.0.1:8000",
    apiKey: "",
    routeKey: "",
    clientLabel: "",
    autoSyncEnabled: true,
    autoSyncMinutes: 60
};

const FLOW_URL = "https://labs.google/fx/tools/flow";
const FLOW_PROJECTS_URL = "https://flow.google.com/projects";
const FLOW_COOKIE_SCOPE = "https://flow.google.com/";
const FLOW_HOSTS = ["https://flow.google.com/", "https://labs.google/"];
const RECAPTCHA_SITE_KEY = "6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV";
const SYNC_ALARM = "flow2apiCookieSync";
const FLOW_SESSION_COOKIES = ["OSID", "__Secure-OSID"];
const GOOGLE_ACCOUNT_COOKIES = ["SID", "HSID", "SSID", "APISID", "SAPISID", "__Secure-1PSID", "__Secure-3PSID"];

let ws = null;
let reconnectTimeout = null;
let heartbeatInterval = null;
let syncInFlight = false;
let lastSync = { at: 0, ok: null, code: "", message: "" };

// ---------------------------------------------------------------- settings

function migrate(stored) {
    const merged = { ...DEFAULT_SETTINGS, ...stored };
    // Older builds stored the WebSocket URL instead of a base address.
    if (!stored.serverBase && stored.serverUrl) {
        merged.serverBase = String(stored.serverUrl)
            .replace(/\/captcha_ws.*$/i, "")
            .replace(/^ws/i, "http");
    }
    return merged;
}

function getSettings() {
    return new Promise((resolve) => {
        chrome.storage.local.get(null, (stored) => {
            const merged = migrate(stored || {});
            resolve({
                serverBase: String(merged.serverBase || DEFAULT_SETTINGS.serverBase).trim().replace(/\/+$/, ""),
                apiKey: String(merged.apiKey || "").trim(),
                routeKey: String(merged.routeKey || "").trim(),
                clientLabel: String(merged.clientLabel || "").trim(),
                autoSyncEnabled: merged.autoSyncEnabled !== false,
                autoSyncMinutes: Math.max(5, Number(merged.autoSyncMinutes) || DEFAULT_SETTINGS.autoSyncMinutes)
            });
        });
    });
}

function saveSettings(values) {
    return new Promise((resolve) => {
        chrome.storage.local.set(values, () => resolve());
    });
}

function wsUrl(settings) {
    return settings.serverBase.replace(/^http/i, "ws") + "/captcha_ws";
}

function updateApiUrl(settings) {
    return settings.serverBase + "/api/plugin/update-token";
}

// ------------------------------------------------------------------ badge

async function refreshBadge() {
    const settings = await getSettings();
    let text = "";
    let color = "#dc2626";
    let title = "Flow2API Companion";
    if (!settings.apiKey) {
        text = "!";
        title = "Flow2API: API Key ausente";
    } else if (!ws || ws.readyState !== WebSocket.OPEN) {
        text = "!";
        title = "Flow2API: extensão desconectada";
    } else if (lastSync.ok === false) {
        text = "!";
        color = "#ce500a";
        title = "Flow2API: falha ao sincronizar cookies";
    } else {
        title = "Flow2API: conectada";
    }
    try {
        chrome.action.setBadgeText({ text });
        if (text) chrome.action.setBadgeBackgroundColor({ color });
        chrome.action.setTitle({ title });
    } catch (e) {
        /* The badge is cosmetic. */
    }
}

// -------------------------------------------------------------- websocket

function closeSocket() {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = null;
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
    if (ws) {
        try {
            ws.close();
        } catch (e) {
            console.log("[Flow2API] close error", e);
        }
        ws = null;
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectWS() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    const settings = await getSettings();
    if (!settings.apiKey) {
        console.warn("[Flow2API] API Key missing; open the extension options.");
        refreshBadge();
        return;
    }

    const url = new URL(wsUrl(settings));
    url.searchParams.set("key", settings.apiKey);
    if (settings.routeKey) url.searchParams.set("route_key", settings.routeKey);
    if (settings.clientLabel) url.searchParams.set("client_label", settings.clientLabel);

    ws = new WebSocket(url.toString());

    ws.onopen = () => {
        console.log("[Flow2API] WebSocket connected");
        ws.send(JSON.stringify({
            type: "register",
            route_key: settings.routeKey,
            client_label: settings.clientLabel
        }));
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        heartbeatInterval = setInterval(() => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "ping" }));
            }
        }, 20000);
        refreshBadge();
    };

    let tokenQueue = Promise.resolve();

    ws.onmessage = (event) => {
        let data;
        try {
            data = JSON.parse(event.data);
        } catch (e) {
            return;
        }
        if (data.type === "register_ack") {
            console.log("[Flow2API] registered route:", data.route_key || "(empty)");
            return;
        }
        if (data.type === "get_token") {
            tokenQueue = tokenQueue.then(() => handleGetToken(data)).catch((err) => {
                console.error("[Flow2API] token queue error", err);
            });
        }
    };

    ws.onclose = () => {
        ws = null;
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        if (reconnectTimeout) clearTimeout(reconnectTimeout);
        reconnectTimeout = setTimeout(connectWS, 2000);
        refreshBadge();
    };

    ws.onerror = (e) => {
        console.log("[Flow2API] WebSocket error", e);
    };
}

// ------------------------------------------------------------ captcha tabs

function waitForTabReady(tabId, timeoutMs = 12000) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            chrome.tabs.onUpdated.removeListener(onUpdated);
            clearTimeout(timer);
            resolve();
        };
        const onUpdated = (updatedTabId, changeInfo) => {
            if (updatedTabId === tabId && changeInfo.status === "complete") finish();
        };
        const timer = setTimeout(finish, timeoutMs);
        chrome.tabs.onUpdated.addListener(onUpdated);
        chrome.tabs.get(tabId, (tab) => {
            if (chrome.runtime.lastError) return finish();
            if (tab && tab.status === "complete") finish();
        });
    });
}

function buildFlowUrl(projectId) {
    return projectId ? `https://flow.google.com/project/${projectId}` : FLOW_URL;
}

async function findExistingFlowTab(urlPrefix) {
    try {
        const tabs = await chrome.tabs.query({});
        const match = tabs.find((tab) => {
            const url = tab.url || "";
            if (urlPrefix) return url.startsWith(urlPrefix);
            return FLOW_HOSTS.some((host) => url.startsWith(host));
        });
        if (match && match.id !== undefined && match.id !== chrome.tabs.TAB_ID_NONE) return match.id;
    } catch (e) {
        console.log("[Flow2API] tab query error", e);
    }
    return null;
}

async function openTab(url, retries = 6) {
    let lastError = null;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const tab = await chrome.tabs.create({ url, active: false });
            return tab.id;
        } catch (e) {
            lastError = e;
            const message = e && e.message ? e.message : String(e);
            if (!/Tabs cannot be edited right now|cannot be edited/i.test(message)) throw e;
            await sleep(700 * attempt);
        }
    }
    throw lastError || new Error("Unable to open a tab");
}

// -------------------------------------------------------------- captcha

async function handleGetToken(data) {
    let tabId = null;
    let reused = false;
    try {
        const targetUrl = buildFlowUrl(data.project_id);
        tabId = await findExistingFlowTab(targetUrl);
        if (tabId !== null) {
            reused = true;
        } else {
            tabId = await openTab(targetUrl);
        }

        await waitForTabReady(tabId);
        await sleep(1200);

        let successResponse = null;
        let lastErrorMsg = "No response from tab.";
        const scriptTimeoutMs = data.action === "VIDEO_GENERATION" ? 30000 : 20000;

        try {
            const results = await chrome.scripting.executeScript({
                target: { tabId },
                world: "MAIN",
                func: async (siteKey, requestedAction, timeoutMs) => {
                    // Flow rewrites the action to "extension_hijack_detected" when
                    // the call comes from an extension; trusted_hook.js captured
                    // the original execute before that happened.
                    const storageKey = "__flow2apiTrustedRecaptchaExecute";
                    for (let attempt = 0; attempt < 40; attempt += 1) {
                        if (window[storageKey]) break;
                        await new Promise((resolve) => setTimeout(resolve, 250));
                    }
                    const capturedExecute = !!window[storageKey];
                    let execute = window[storageKey];
                    if (!execute) {
                        const enterprise = window.grecaptcha && window.grecaptcha.enterprise;
                        execute = enterprise && enterprise.execute;
                    }
                    if (typeof execute !== "function") {
                        return {
                            ok: false,
                            error: "reCAPTCHA execute is unavailable | captured=" + capturedExecute
                                + " hook=" + !!window.__flow2apiTrustedRecaptchaHookInstalled
                                + " url=" + location.href
                        };
                    }
                    let executeTarget = siteKey;
                    try {
                        if (!capturedExecute
                            && window.grecaptcha
                            && window.grecaptcha.enterprise
                            && typeof window.grecaptcha.enterprise.render === "function"
                            && window.__flow2apiRecaptchaClientId === undefined) {
                            window.__flow2apiRecaptchaClientId = window.grecaptcha.enterprise.render(
                                document.documentElement,
                                { sitekey: siteKey, action: requestedAction }
                            );
                        }
                        if (window.__flow2apiRecaptchaClientId !== undefined) {
                            executeTarget = window.__flow2apiRecaptchaClientId;
                        }
                    } catch (renderError) {
                        return {
                            ok: false,
                            error: (renderError && renderError.message) ? renderError.message : String(renderError)
                        };
                    }
                    try {
                        const token = await new Promise((resolve, reject) => {
                            let settled = false;
                            const finish = (handler, value) => {
                                if (settled) return;
                                settled = true;
                                handler(value);
                            };
                            const timer = setTimeout(() => finish(reject, new Error("execute timeout")), timeoutMs);
                            try {
                                Promise.resolve(execute(executeTarget, { action: requestedAction }))
                                    .then((value) => { clearTimeout(timer); finish(resolve, value); })
                                    .catch((error) => { clearTimeout(timer); finish(reject, error); });
                            } catch (error) {
                                clearTimeout(timer);
                                finish(reject, error);
                            }
                        });
                        return { ok: true, token };
                    } catch (error) {
                        return {
                            ok: false,
                            error: (error && error.message ? error.message : String(error))
                                + " | captured=" + capturedExecute
                                + " actionGuard=" + !!window.__flow2apiRecaptchaActionGuardInstalled
                                + " url=" + location.href
                        };
                    }
                },
                args: [RECAPTCHA_SITE_KEY, data.action || "IMAGE_GENERATION", scriptTimeoutMs]
            });

            const outcome = results && results[0] ? results[0].result : null;
            if (outcome && outcome.ok && outcome.token) {
                successResponse = { status: "success", token: outcome.token };
            } else if (outcome && outcome.error) {
                lastErrorMsg = outcome.error;
            } else if (!outcome) {
                lastErrorMsg = "Extension script returned no result";
            }
        } catch (e) {
            lastErrorMsg = e.message || "Script execution failed";
        }

        if (successResponse) {
            ws.send(JSON.stringify({
                req_id: data.req_id,
                status: successResponse.status,
                token: successResponse.token
            }));
        } else {
            ws.send(JSON.stringify({
                req_id: data.req_id,
                status: "error",
                error: "Extension script failed: " + lastErrorMsg
            }));
        }
    } catch (err) {
        ws.send(JSON.stringify({
            req_id: data.req_id,
            status: "error",
            error: err.message
        }));
    } finally {
        if (tabId && !reused) {
            try {
                await chrome.tabs.remove(tabId);
            } catch (e) {
                console.log("[Flow2API] close tab error", e);
            }
        }
    }
}

// ---------------------------------------------------------- cookie sync

function serializeCookies(cookies) {
    const seen = new Map();
    for (const cookie of cookies) {
        if (!cookie || !cookie.name || !cookie.value) continue;
        const key = [cookie.name, cookie.domain, cookie.path, cookie.storeId || ""].join("\u0000");
        if (seen.has(key)) continue;
        const item = {
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain || "",
            path: cookie.path || "/",
            secure: Boolean(cookie.secure),
            httpOnly: Boolean(cookie.httpOnly),
            hostOnly: Boolean(cookie.hostOnly),
            session: Boolean(cookie.session)
        };
        if (Number.isFinite(cookie.expirationDate)) item.expirationDate = cookie.expirationDate;
        if (cookie.sameSite) item.sameSite = cookie.sameSite;
        seen.set(key, item);
    }
    return Array.from(seen.values());
}

async function syncCookies(reason = "manual") {
    if (syncInFlight) {
        return { ok: false, code: "already_running", message: "A sync is already running." };
    }
    syncInFlight = true;
    let tabId = null;
    try {
        const settings = await getSettings();
        if (!settings.apiKey) {
            throw Object.assign(new Error("API Key is missing."), { code: "missing_key" });
        }

        tabId = await openTab(FLOW_PROJECTS_URL);
        await waitForTabReady(tabId);
        await sleep(1500);

        const tab = await chrome.tabs.get(tabId);
        let host = "";
        try {
            host = new URL(tab.url || "").hostname.toLowerCase();
        } catch (e) {
            host = "";
        }
        if (host !== "flow.google.com") {
            throw Object.assign(
                new Error("The Flow session is gone. Sign in to flow.google.com in this profile."),
                { code: "flow_session_lost" }
            );
        }

        const cookies = serializeCookies(
            await chrome.cookies.getAll({ url: FLOW_COOKIE_SCOPE })
        );
        const names = new Set(cookies.map((c) => c.name));
        const hasFlow = FLOW_SESSION_COOKIES.some((name) => names.has(name));
        const hasGoogle = GOOGLE_ACCOUNT_COOKIES.some((name) => names.has(name));
        if (!hasFlow || !hasGoogle) {
            throw Object.assign(
                new Error(
                    "Incomplete cookies: "
                    + (!hasFlow ? "Flow session (OSID) " : "")
                    + (!hasGoogle ? "Google account (SID/HSID)" : "")
                ),
                { code: "cookies_incomplete" }
            );
        }

        const response = await fetch(updateApiUrl(settings), {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${settings.apiKey}`
            },
            body: JSON.stringify({
                google_cookies: JSON.stringify(cookies),
                protocol_mode: "protocol"
            })
        });

        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw Object.assign(
                new Error(payload.detail || `HTTP ${response.status}`),
                { code: "http_error" }
            );
        }

        lastSync = {
            at: Date.now(),
            ok: true,
            code: "",
            email: payload.email || "",
            message: payload.message || "Cookies synced."
        };
        await refreshBadge();
        return {
            ok: true,
            message: lastSync.message,
            email: lastSync.email,
            action: payload.action || ""
        };
    } catch (error) {
        const code = error.code || "network_error";
        lastSync = {
            at: Date.now(),
            ok: false,
            code,
            message: error.message || String(error)
        };
        await refreshBadge();
        return { ok: false, code, message: lastSync.message };
    } finally {
        syncInFlight = false;
        if (tabId !== null) {
            try {
                await chrome.tabs.remove(tabId);
            } catch (e) {
                /* already closed */
            }
        }
    }
}

async function configureAlarm() {
    const settings = await getSettings();
    await chrome.alarms.clear(SYNC_ALARM);
    if (!settings.autoSyncEnabled || !settings.apiKey) return;
    chrome.alarms.create(SYNC_ALARM, {
        periodInMinutes: settings.autoSyncMinutes,
        delayInMinutes: Math.min(2, settings.autoSyncMinutes)
    });
}

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === SYNC_ALARM) syncCookies("alarm");
});

// ------------------------------------------------------------- plumbing

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) return false;

    if (message.type === "status") {
        getSettings().then((settings) => {
            sendResponse({
                settings,
                wsState: ws ? ws.readyState : 3,
                syncing: syncInFlight,
                lastSync
            });
        });
        return true;
    }
    if (message.type === "save") {
        saveSettings(message.values || {}).then(async () => {
            await configureAlarm();
            closeSocket();
            connectWS();
            sendResponse({ ok: true });
        });
        return true;
    }
    if (message.type === "sync") {
        syncCookies("manual").then(sendResponse);
        return true;
    }
    if (message.type === "reconnect") {
        closeSocket();
        connectWS();
        sendResponse({ ok: true });
        return true;
    }
    return false;
});

chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (["serverBase", "apiKey", "routeKey", "clientLabel"].some((key) => changes[key])) {
        closeSocket();
        connectWS();
    }
    if (["autoSyncEnabled", "autoSyncMinutes"].some((key) => changes[key])) {
        configureAlarm();
    }
});

if (chrome.action && chrome.action.onClicked) {
    chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
}

chrome.runtime.onInstalled.addListener(async () => {
    const settings = await getSettings();
    await configureAlarm();
    if (!settings.apiKey) chrome.runtime.openOptionsPage();
    else connectWS();
});

chrome.runtime.onStartup.addListener(async () => {
    await configureAlarm();
    connectWS();
});

// Boot.
configureAlarm();
connectWS();
refreshBadge();
