let ws = null;
let reconnectTimeout = null;
let heartbeatInterval = null;

const DEFAULT_SETTINGS = {
    serverUrl: "ws://127.0.0.1:8000/captcha_ws",
    apiKey: "",
    routeKey: "",
    clientLabel: ""
};

function getSettings() {
    return new Promise((resolve) => {
        chrome.storage.local.get(DEFAULT_SETTINGS, (stored) => {
            resolve({
                serverUrl: (stored.serverUrl || DEFAULT_SETTINGS.serverUrl).trim(),
                apiKey: (stored.apiKey || "").trim(),
                routeKey: (stored.routeKey || "").trim(),
                clientLabel: (stored.clientLabel || "").trim()
            });
        });
    });
}

function setBadge(text) {
    try {
        chrome.action.setBadgeText({ text: text || "" });
        if (text) {
            chrome.action.setBadgeBackgroundColor({ color: "#dc2626" });
        }
    } catch (e) {
        // Badge is cosmetic; never let it break the connection.
    }
}

function closeSocket() {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = null;
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
    if (ws) {
        try {
            ws.close();
        } catch (e) {
            console.log("[Flow2API] Close socket error", e);
        }
        ws = null;
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

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
            if (updatedTabId === tabId && changeInfo.status === "complete") {
                finish();
            }
        };
        const timer = setTimeout(finish, timeoutMs);

        chrome.tabs.onUpdated.addListener(onUpdated);
        chrome.tabs.get(tabId, (tab) => {
            if (chrome.runtime.lastError) {
                finish();
                return;
            }
            if (tab && tab.status === "complete") {
                finish();
            }
        });
    });
}

async function connectWS() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    const settings = await getSettings();
    if (!settings.apiKey) {
        // Without a key the server closes the handshake with 403, so retrying is
        // pointless. Flag it on the toolbar instead of looping silently.
        console.warn("[Flow2API] API Key is missing. Open the extension options and paste the key shown in the web panel.");
        setBadge("!");
        return;
    }
    const url = new URL(settings.serverUrl || DEFAULT_SETTINGS.serverUrl);
    if (settings.apiKey) {
        url.searchParams.set("key", settings.apiKey);
    }
    if (settings.routeKey) {
        url.searchParams.set("route_key", settings.routeKey);
    }
    if (settings.clientLabel) {
        url.searchParams.set("client_label", settings.clientLabel);
    }

    ws = new WebSocket(url.toString());

    ws.onopen = () => {
        console.log("[Flow2API] Background connected to WebSocket", url.toString());
        setBadge("");
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
    };

    let tokenQueue = Promise.resolve();

    ws.onmessage = async (event) => {
        let data;
        try {
            data = JSON.parse(event.data);
        } catch (e) {
            return;
        }

        if (data.type === "register_ack") {
            console.log("[Flow2API] Registered route key:", data.route_key || "(empty)");
            return;
        }

        if (data.type === "get_token") {
            tokenQueue = tokenQueue.then(() => handleGetToken(data)).catch(err => {
                console.error("[Flow2API] Queue Error:", err);
            });
        }
    };

    ws.onclose = () => {
        console.log("[Flow2API] WebSocket Closed. Reconnecting in 2s...");
        ws = null;
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        if (reconnectTimeout) clearTimeout(reconnectTimeout);
        reconnectTimeout = setTimeout(connectWS, 2000);
    };

    ws.onerror = (e) => {
        console.log("[Flow2API] WebSocket Error", e);
    };
}

// Clicking the toolbar icon opens the settings page, so the configuration screen
// is always one click away.
if (chrome.action && chrome.action.onClicked) {
    chrome.action.onClicked.addListener(() => {
        chrome.runtime.openOptionsPage();
    });
}

chrome.runtime.onInstalled.addListener(async () => {
    const settings = await getSettings();
    if (!settings.apiKey) {
        chrome.runtime.openOptionsPage();
    }
});

const FLOW_URL = "https://labs.google/fx/tools/flow";
const FLOW_HOSTS = ["https://flow.google.com/", "https://labs.google/"];
const RECAPTCHA_SITE_KEY = "6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV";

function buildFlowUrl(projectId) {
    if (projectId) {
        return `https://flow.google.com/project/${projectId}`;
    }
    return FLOW_URL;
}

async function findExistingFlowTab(urlPrefix) {
    try {
        const tabs = await chrome.tabs.query({});
        const match = tabs.find((tab) => {
            const url = tab.url || "";
            if (urlPrefix) return url.startsWith(urlPrefix);
            return FLOW_HOSTS.some((host) => url.startsWith(host));
        });
        if (match && match.id !== undefined && match.id !== chrome.tabs.TAB_ID_NONE) {
            return match.id;
        }
    } catch (e) {
        console.log("[Flow2API] Tab query error", e);
    }
    return null;
}

async function openFlowTab(url, retries = 6) {
    let lastError = null;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const tab = await chrome.tabs.create({ url, active: false });
            return tab.id;
        } catch (e) {
            lastError = e;
            const message = e && e.message ? e.message : String(e);
            console.log(`[Flow2API] tabs.create failed (${attempt}/${retries}): ${message}`);
            if (!/Tabs cannot be edited right now|cannot be edited/i.test(message)) {
                throw e;
            }
            await sleep(700 * attempt);
        }
    }
    throw lastError || new Error("Unable to open a Google Labs tab");
}

async function handleGetToken(data) {
    let newTabId = null;
    let reusedTab = false;
    try {
        // The Flow app only binds the trusted reCAPTCHA execute on the project
        // page, so that is the page we need the token from.
        const targetUrl = buildFlowUrl(data.project_id);
        console.log(`[Flow2API] Resolving Google Labs tab (${targetUrl})...`);
        newTabId = await findExistingFlowTab(targetUrl);
        if (newTabId !== null) {
            reusedTab = true;
            console.log(`[Flow2API] Reusing existing tab ${newTabId}`);
        } else {
            newTabId = await openFlowTab(targetUrl);
            console.log("[Flow2API] Auto-opening fresh Google Labs tab to avoid token expiry...");
        }

        await waitForTabReady(newTabId);
        await sleep(1200);

        let successResponse = null;
        let lastErrorMsg = "No response from tab.";
        const scriptTimeoutMs = data.action === "VIDEO_GENERATION" ? 30000 : 20000;

        try {
            const results = await chrome.scripting.executeScript({
                target: { tabId: newTabId },
                world: "MAIN",
                func: async (siteKey, requestedAction, timeoutMs) => {
                    // Port of src/services/recaptcha_runtime.py
                    // (RECAPTCHA_EXECUTE_SOURCE). Flow hijacks the public execute
                    // and rewrites the action to "extension_hijack_detected";
                    // trusted_hook.js captures the original before that happens.
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
                                + " url=" + location.href,
                        };
                    }

                    let executeTarget = siteKey;
                    try {
                        if (
                            !capturedExecute &&
                            window.grecaptcha &&
                            window.grecaptcha.enterprise &&
                            typeof window.grecaptcha.enterprise.render === "function" &&
                            window.__flow2apiRecaptchaClientId === undefined
                        ) {
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
                            error: (renderError && renderError.message)
                                ? renderError.message
                                : String(renderError),
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
                            const timer = setTimeout(
                                () => finish(reject, new Error("execute timeout")),
                                timeoutMs
                            );
                            try {
                                Promise.resolve(execute(executeTarget, { action: requestedAction }))
                                    .then((value) => {
                                        clearTimeout(timer);
                                        finish(resolve, value);
                                    })
                                    .catch((error) => {
                                        clearTimeout(timer);
                                        finish(reject, error);
                                    });
                            } catch (error) {
                                clearTimeout(timer);
                                finish(reject, error);
                            }
                        });
                        return { ok: true, token };
                    } catch (error) {
                        const debug = {
                            captured: capturedExecute,
                            actionGuard: !!window.__flow2apiRecaptchaActionGuardInstalled,
                            hookInstalled: !!window.__flow2apiTrustedRecaptchaHookInstalled,
                            executeTarget: String(executeTarget),
                            url: location.href,
                        };
                        return {
                            ok: false,
                            error: (error && error.message ? error.message : String(error))
                                + " | " + JSON.stringify(debug),
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
        if (newTabId && !reusedTab) {
            try {
                await chrome.tabs.remove(newTabId);
                console.log("[Flow2API] Closed temporary token tab.");
            } catch (e) {
                console.log("[Flow2API] Error closing tab:", e);
            }
        }
    }
}

chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes.routeKey || changes.serverUrl || changes.apiKey || changes.clientLabel) {
        console.log("[Flow2API] Extension settings changed, reconnecting WebSocket...");
        closeSocket();
        connectWS();
    }
});

connectWS();
