/* Flow2API Companion — settings screen.
 *
 * The page never talks to the server directly: background.js owns the WebSocket
 * and the cookie sync, and answers `status` / `save` / `sync` messages.
 */
const $ = (id) => document.getElementById(id);
let locale = "pt-BR";
let translations = {};

const STATUS_CODES = {
  missing_key: "Informe a API Key.",
  flow_session_lost: "A sessão do Flow caiu. Entre em flow.google.com neste perfil do navegador.",
  cookies_incomplete: "Cookies incompletos: faça login no Google e abra o Flow uma vez.",
  already_running: "Já existe uma sincronização em andamento.",
  network_error: "Não foi possível falar com o servidor. Confira o endereço.",
  http_error: "O servidor recusou a sincronização."
};

function translate(source, params = {}) {
  const message = (translations[locale] && translations[locale][source]) || source;
  return String(message).replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match);
}

function renderLanguage() {
  document.documentElement.lang = locale;
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    element.textContent = translate(element.dataset.i18n);
  });
  $("language").value = locale;
}

async function loadLanguage() {
  try {
    const response = await fetch("locales.json");
    translations = response.ok ? await response.json() : {};
  } catch (e) {
    translations = {};
  }
  const stored = await new Promise((resolve) =>
    chrome.storage.local.get(["uiLanguage"], (items) => resolve(items.uiLanguage)));
  const candidates = [stored, ...(navigator.languages || [navigator.language])];
  const match = candidates.find((value) => /^(zh|en|pt)(-|$)/i.test(value || "")) || "";
  if (/^zh(-|$)/i.test(match)) locale = "zh-CN";
  else if (/^en(-|$)/i.test(match)) locale = "en";
  else locale = "pt-BR";
  renderLanguage();
}

function formatTime(timestamp) {
  if (!timestamp) return "";
  try {
    return new Date(timestamp).toLocaleString(locale);
  } catch (e) {
    return "";
  }
}

function setPill(state) {
  const pill = $("statusPill");
  if (state === "on") {
    pill.className = "pill on";
    pill.textContent = translate("Conectada");
  } else if (state === "off") {
    pill.className = "pill off";
    pill.textContent = translate("Desconectada");
  } else {
    pill.className = "pill";
    pill.textContent = translate("Sem API Key");
  }
}

function renderStatus(data) {
  const { settings, wsState, lastSync, syncing } = data;

  if (!settings.apiKey) setPill("nokey");
  else if (wsState === 1) setPill("on");
  else setPill("off");

  if (lastSync && lastSync.at) {
    if (lastSync.ok) {
      $("accountLine").textContent = lastSync.email || lastSync.message || translate("Sincronizado");
    } else {
      $("accountLine").textContent = translate("Nenhuma sincronização ainda");
    }
    const box = $("syncResult");
    const when = formatTime(lastSync.at);
    if (lastSync.ok) {
      box.className = "hint ok";
      box.textContent = translate("Última sincronização: {0}", { "0": when });
    } else {
      box.className = "hint err";
      const reason = STATUS_CODES[lastSync.code]
        ? translate(STATUS_CODES[lastSync.code])
        : lastSync.message;
      box.textContent = translate("Falha: {0}", { "0": reason });
    }
  }

  const syncBtn = $("syncBtn");
  syncBtn.disabled = Boolean(syncing);
  syncBtn.textContent = syncing ? translate("Sincronizando...") : translate("Sincronizar agora");
}

async function refresh() {
  try {
    const data = await chrome.runtime.sendMessage({ type: "status" });
    if (data) renderStatus(data);
  } catch (e) {
    /* Service worker asleep; the next tick retries. */
  }
}

async function loadSettings() {
  try {
    const data = await chrome.runtime.sendMessage({ type: "status" });
    const settings = (data && data.settings) || {};
    $("serverBase").value = settings.serverBase || "http://127.0.0.1:8000";
    $("apiKey").value = settings.apiKey || "";
    $("routeKey").value = settings.routeKey || "";
    $("clientLabel").value = settings.clientLabel || "";
    $("autoSync").checked = settings.autoSyncEnabled !== false;
    $("autoSyncMinutes").value = settings.autoSyncMinutes || 60;
    if (data) renderStatus(data);
  } catch (e) {
    console.warn("unable to load settings", e);
  }
}

async function save(showHint) {
  const serverBase = $("serverBase").value.trim().replace(/\/+$/, "");
  const apiKey = $("apiKey").value.trim();
  if (!/^https?:\/\/.+/i.test(serverBase)) {
    $("syncResult").className = "hint err";
    $("syncResult").textContent = translate("Endereço inválido. Use algo como http://127.0.0.1:8000");
    return false;
  }
  if (!apiKey) {
    $("syncResult").className = "hint err";
    $("syncResult").textContent = translate("Informe a API Key.");
    return false;
  }
  await chrome.runtime.sendMessage({
    type: "save",
    values: {
      serverBase,
      apiKey,
      routeKey: $("routeKey").value.trim(),
      clientLabel: $("clientLabel").value.trim(),
      autoSyncEnabled: $("autoSync").checked,
      autoSyncMinutes: Math.max(5, Number($("autoSyncMinutes").value) || 60)
    }
  });
  if (showHint) {
    $("syncResult").className = "hint ok";
    $("syncResult").textContent = translate("Salvo. Conectando...");
  }
  return true;
}

async function runSync() {
  const ok = await save(false);
  if (!ok) return;
  $("syncBtn").disabled = true;
  $("syncBtn").textContent = translate("Sincronizando...");
  const result = await chrome.runtime.sendMessage({ type: "sync" });
  if (result && !result.ok) {
    const reason = STATUS_CODES[result.code] ? translate(STATUS_CODES[result.code]) : result.message;
    $("syncResult").className = "hint err";
    $("syncResult").textContent = translate("Falha: {0}", { "0": reason });
  }
  refresh();
}

$("saveBtn").addEventListener("click", () => save(true));
$("syncBtn").addEventListener("click", runSync);
$("autoSync").addEventListener("change", () => save(false));
$("autoSyncMinutes").addEventListener("change", () => save(false));
$("language").addEventListener("change", (event) => {
  chrome.storage.local.set({ uiLanguage: event.target.value });
  locale = event.target.value;
  renderLanguage();
  refresh();
});

loadLanguage().then(async () => {
  await loadSettings();
  refresh();
  setInterval(refresh, 2000);
});
