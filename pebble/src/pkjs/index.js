/* Phone-side API bridge + Clay settings for PebblePilot */
var Clay = require("@rebble/clay");
var clayConfig = require("./clay-config");
var moddableProxy = require("@moddable/pebbleproxy");

var clay = new Clay(clayConfig, null, { autoHandleEvents: false });
var SETTINGS_KEY = "pebblepilot-settings";
var TIMEOUT_MS = 12000;

// Placeholders only — real values come from Clay phone settings (localStorage).
// Do not put secrets or LAN IPs here; they would be committed to git.
var defaults = {
  DaemonUrl: "http://127.0.0.1:8787",
  DaemonToken: "",
  CursorApiKey: ""
};

var CMD = {
  PROJECTS: 1,
  AGENTS: 2,
  AGENT: 3,
  START: 4,
  STOP: 5,
  APPROVE: 6
};

function clip(s, max) {
  s = String(s || "");
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function pickValue(store, key, fallback) {
  if (!store || store[key] === undefined || store[key] === null) return fallback;
  var v = store[key];
  // Clay sometimes stores { value: "..." } and sometimes a flat string.
  if (typeof v === "object" && v && "value" in v) v = v.value;
  if (v === undefined || v === null) return fallback;
  return v;
}

function readClayStore() {
  try {
    return JSON.parse(localStorage.getItem("clay-settings") || "{}") || {};
  } catch (e) {
    return {};
  }
}

function readAppStore() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") || {};
  } catch (e) {
    return {};
  }
}

function loadSettings() {
  var clayStore = readClayStore();
  var appStore = readAppStore();
  return {
    DaemonUrl: String(
      pickValue(clayStore, "DaemonUrl", pickValue(appStore, "DaemonUrl", defaults.DaemonUrl))
    ),
    DaemonToken: String(
      pickValue(clayStore, "DaemonToken", pickValue(appStore, "DaemonToken", defaults.DaemonToken))
    ),
    CursorApiKey: String(
      pickValue(clayStore, "CursorApiKey", pickValue(appStore, "CursorApiKey", defaults.CursorApiKey))
    )
  };
}

function persistSettings(values) {
  var next = {
    DaemonUrl: values.DaemonUrl || defaults.DaemonUrl,
    DaemonToken: values.DaemonToken || defaults.DaemonToken,
    CursorApiKey: values.CursorApiKey || ""
  };
  // App copy
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  // Clay expects FLAT key/value pairs in clay-settings (not {value:...})
  clay.setSettings(next);
  return next;
}

function flattenClayResponse(raw) {
  var flat = {};
  Object.keys(raw || {}).forEach(function (key) {
    var v = raw[key];
    if (typeof v === "object" && v && "value" in v) flat[key] = v.value;
    else flat[key] = v;
  });
  return flat;
}

function xhr(method, path, body, cb) {
  var settings = loadSettings();
  var base = String(settings.DaemonUrl || defaults.DaemonUrl).replace(/\/$/, "");
  var token = settings.DaemonToken || defaults.DaemonToken;
  var url = base + path;
  var req = new XMLHttpRequest();
  var done = false;
  var timer = setTimeout(function () {
    if (done) return;
    done = true;
    try { req.abort(); } catch (e) {}
    cb(new Error("Timeout"));
  }, TIMEOUT_MS);

  req.open(method, url, true);
  req.setRequestHeader("Authorization", "Bearer " + token);
  req.setRequestHeader("Content-Type", "application/json");
  // Always send Clay-saved key so daemon never uses a stale/test key.
  var cursorKey = String(settings.CursorApiKey || "").trim();
  if (cursorKey) {
    req.setRequestHeader("X-Cursor-Api-Key", cursorKey);
  }
  req.onreadystatechange = function () {
    if (req.readyState !== 4 || done) return;
    done = true;
    clearTimeout(timer);
    var data = {};
    try { data = JSON.parse(req.responseText || "{}"); } catch (e) { data = {}; }
    if (req.status < 200 || req.status >= 300) {
      var msg = data.error || ("HTTP " + req.status);
      if (data.code === "missing_api_key") {
        msg =
          "No Cursor API key. Open PebblePilot settings on your phone, paste your key, and Save.";
      } else if (data.code === "unauthorized") {
        msg = "Daemon token mismatch. Check PebblePilot settings and PEBBLEPILOT_TOKEN in .env.";
      }
      cb(new Error(msg));
      return;
    }
    cb(null, data);
  };
  req.onerror = function () {
    if (done) return;
    done = true;
    clearTimeout(timer);
    cb(new Error("Network error"));
  };
  req.send(body ? JSON.stringify(body) : null);
}

function pushApiKeyToDaemon(cb) {
  var settings = loadSettings();
  var key = String(settings.CursorApiKey || "").trim();
  if (!key) {
    if (cb) cb(null, { skipped: true });
    return;
  }
  xhr("POST", "/settings", { cursorApiKey: key }, function (err, res) {
    if (err) console.log("PebblePilot push key failed: " + err.message);
    else console.log("PebblePilot API key synced to daemon");
    if (cb) cb(err, res);
  });
}

function reply(cmd, ok, payloadObj) {
  var payload = "";
  try { payload = JSON.stringify(payloadObj || {}); } catch (e) { payload = "{}"; }
  payload = clip(payload, 900);
  Pebble.sendAppMessage({
    CMD: cmd,
    STATUS: ok ? 1 : 0,
    PAYLOAD: payload
  });
}

function handleCommand(cmd, arg, data) {
  if (cmd === CMD.PROJECTS) {
    xhr("GET", "/projects", null, function (err, res) {
      if (err) return reply(cmd, false, { error: err.message });
      var projects = (res.projects || []).map(function (p) {
        return {
          id: p.id,
          name: p.name,
          presets: (p.presets || []).slice(0, 5)
        };
      });
      reply(cmd, true, { projects: projects });
    });
    return;
  }

  if (cmd === CMD.AGENTS) {
    xhr("GET", "/pebble/agents", null, function (err, res) {
      if (err) return reply(cmd, false, { error: err.message });
      reply(cmd, true, { agents: (res.agents || []).slice(0, 6) });
    });
    return;
  }

  if (cmd === CMD.AGENT) {
    xhr("GET", "/pebble/agents/" + encodeURIComponent(arg), null, function (err, res) {
      if (err) return reply(cmd, false, { error: err.message });
      reply(cmd, true, { agent: res.agent });
    });
    return;
  }

  if (cmd === CMD.START) {
    var settings = loadSettings();
    if (!String(settings.CursorApiKey || "").trim()) {
      return reply(cmd, false, {
        error: "No Cursor API key in phone settings. Open PebblePilot settings, paste key, Save."
      });
    }
    xhr("POST", "/agents", { projectId: arg, prompt: data }, function (err, res) {
      if (err) return reply(cmd, false, { error: err.message });
      var agent = res.agent || {};
      reply(cmd, true, {
        agent: {
          id: agent.id,
          name: agent.projectName || arg,
          task: clip(agent.task || data, 80),
          status: agent.status || "starting",
          elapsed: "0m 00s",
          activity: agent.error || "Starting...",
          summary: "",
          error: agent.error || "",
          files: 0,
          insertions: 0,
          deletions: 0,
          needsApproval: false,
          log: []
        }
      });
    });
    return;
  }

  if (cmd === CMD.STOP) {
    xhr("POST", "/agents/" + encodeURIComponent(arg) + "/stop", {}, function (err) {
      if (err) return reply(cmd, false, { error: err.message });
      xhr("GET", "/pebble/agents/" + encodeURIComponent(arg), null, function (err2, res2) {
        if (err2) return reply(cmd, true, { agent: { id: arg, status: "stopped" } });
        reply(cmd, true, { agent: res2.agent });
      });
    });
    return;
  }

  if (cmd === CMD.APPROVE) {
    xhr("POST", "/agents/" + encodeURIComponent(arg) + "/approve", { choice: data || "continue" }, function (err) {
      if (err) return reply(cmd, false, { error: err.message });
      xhr("GET", "/pebble/agents/" + encodeURIComponent(arg), null, function (err2, res2) {
        if (err2) return reply(cmd, true, { agent: { id: arg, status: "working" } });
        reply(cmd, true, { agent: res2.agent });
      });
    });
    return;
  }

  reply(cmd || 0, false, { error: "Unknown command" });
}

Pebble.addEventListener("ready", function (e) {
  moddableProxy.readyReceived(e);
  // Keep both stores in sync on launch
  persistSettings(loadSettings());
  var settings = loadSettings();
  console.log("PebblePilot PKJS ready → " + settings.DaemonUrl);
  pushApiKeyToDaemon();
});

Pebble.addEventListener("showConfiguration", function () {
  // Inject current flat values so Clay fields are pre-filled
  persistSettings(loadSettings());
  Pebble.openURL(clay.generateUrl());
});

Pebble.addEventListener("webviewclosed", function (e) {
  // User cancelled / closed without Save
  if (!e || !e.response) {
    console.log("PebblePilot settings closed without save");
    return;
  }
  try {
    // IMPORTANT: convert=false — default convert=true returns AppMessage keys
    // (numeric), which made us overwrite settings with empty defaults.
    var raw = clay.getSettings(e.response, false);
    var flat = flattenClayResponse(raw);
    var saved = persistSettings({
      CursorApiKey: flat.CursorApiKey || "",
      DaemonUrl: flat.DaemonUrl || defaults.DaemonUrl,
      DaemonToken: flat.DaemonToken || defaults.DaemonToken
    });
    console.log(
      "PebblePilot settings saved → url=" +
        saved.DaemonUrl +
        " tokenLen=" +
        String(saved.DaemonToken || "").length +
        " keyLen=" +
        String(saved.CursorApiKey || "").length
    );
    pushApiKeyToDaemon();
  } catch (err) {
    console.log("PebblePilot settings parse error: " + err.message);
  }
});

Pebble.addEventListener("appmessage", function (e) {
  if (moddableProxy.appMessageReceived(e)) return;
  var p = e.payload || {};
  handleCommand(p.CMD, p.ARG || "", p.DATA || "");
});
