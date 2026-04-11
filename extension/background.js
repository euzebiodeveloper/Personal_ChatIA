/**
 * Background service worker — manages the WebSocket connection to the
 * Electron bridge and relays messages to/from the active tab's content script.
 */

const BRIDGE_URL = 'ws://127.0.0.1:49152';
const RECONNECT_DELAY_MS = 3000;

let ws = null;
let connected = false;

function connect() {
  try {
    ws = new WebSocket(BRIDGE_URL);
  } catch (e) {
    scheduleReconnect();
    return;
  }

  ws.onopen = async function() {
    connected = true;
    console.log('[bridge-bg] conectado ao Electron');
    ws.send(JSON.stringify({ type: 'connected' }));
    updateIcon(true);
    // Re-inject content.js into ALL open http/https tabs so the latest version
    // is always running — even in tabs loaded before the extension connected.
    try {
      const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
      for (var i = 0; i < tabs.length; i++) {
        var tab = tabs[i];
        if (!tab.id) continue;
        try {
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
          console.log('[bridge-bg] content.js re-injetado na aba ' + tab.id + ': ' + tab.url);
        } catch (tabErr) { /* aba restrita ou não disponível */ }
      }
    } catch (e) { /* erro ao listar abas */ }
  };

  ws.onmessage = async function(event) {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (parseErr) {
      return;
    }

    // Browser-level tab actions are handled directly here — no content script or active tab needed.
    if (msg.type === 'browser_action') {
      ws.send(JSON.stringify({ type: 'dom_result', requestId: msg.requestId, elements: [] }));
      try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const tabId = tabs[0] ? tabs[0].id : undefined;
        switch (msg.action) {
          case 'new_tab':    await chrome.tabs.create({}); break;
          case 'close_tab':  if (tabId) await chrome.tabs.remove(tabId); break;
          case 'reload':     if (tabId) await chrome.tabs.reload(tabId); break;
          case 'go_back':    if (tabId) await chrome.tabs.goBack(tabId); break;
          case 'go_forward': if (tabId) await chrome.tabs.goForward(tabId); break;
        }
      } catch (e) { console.warn('[bridge-bg] browser_action falhou:', e.message); }
      return;
    }

    // Forward to the active tab's content script
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs[0] ? tabs[0].id : undefined;
    if (!tabId) {
      ws.send(JSON.stringify({ type: 'dom_error', requestId: msg.requestId, message: 'nenhuma aba ativa' }));
      return;
    }

    const tabUrl = tabs[0] ? (tabs[0].url || '') : '';
    if (/^(chrome|edge|brave|opera|about|data|javascript):\/\//i.test(tabUrl)) {
      ws.send(JSON.stringify({ type: 'dom_error', requestId: msg.requestId, message: 'chrome_restricted_url' }));
      return;
    }

    try {
      const response = await chrome.tabs.sendMessage(tabId, msg);
      ws.send(JSON.stringify(response));
    } catch (err) {
      // Content script not present (tab loaded before extension) — inject it and retry once
      try {
        await chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['content.js'] });
        await new Promise(function(r) { setTimeout(r, 250); });
        const response = await chrome.tabs.sendMessage(tabId, msg);
        ws.send(JSON.stringify(response));
      } catch (injectErr) {
        ws.send(JSON.stringify({
          type: 'dom_error',
          requestId: msg.requestId,
          message: injectErr.message || 'erro ao injetar content script',
        }));
      }
    }
  };

  ws.onerror = () => {};

  ws.onclose = () => {
    connected = false;
    updateIcon(false);
    console.log('[bridge-bg] desconectado — reconectando...');
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  setTimeout(connect, RECONNECT_DELAY_MS);
}

function updateIcon(active) {
  chrome.action.setTitle({ title: active ? 'AI Assistant: conectado' : 'AI Assistant: desconectado' });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'get_status') {
    sendResponse({ connected });
  }
});

// Keep the service worker alive — Chrome MV3 kills idle workers after ~30s.
// Firing an alarm every 10 s forces the worker to stay active and matches the
// server-side ping interval so the WS connection is never left idle long enough
// for Chrome or the TCP stack to silently drop it.
chrome.alarms.create('keepalive', { periodInMinutes: 0.17 }); // ~10 s
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive' && !connected) {
    connect();
  }
});

// Start connection when service worker loads
connect();
