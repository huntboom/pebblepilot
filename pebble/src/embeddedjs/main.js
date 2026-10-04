import Poco from "commodetto/Poco";
import Button from "pebble/button";
import Dictation from "pebble/dictation";
import {
  initApi,
  fetchAgents,
  fetchAgent,
  fetchProjects,
  fetchProject,
  startAgent,
  stopAgent,
  approveAgent,
} from "./api";
import { POLL_MS } from "./config";

const HEADER_H = 16;
const CELL_H = 44;
const STATUS_H = 18;
const LINE_H = 16;
const MAX_AGENTS = 5;
const WRAP_CHARS = 26;
const DEFAULT_PRESETS = [
  "Summarize this repo in 3 bullets.",
  "Check git status and open work.",
  "Suggest one small improvement.",
];
// Cycle with Select on the Push policy row
const PUSH_POLICIES = ["none", "ask", "push"];
const PUSH_LABELS = {
  none: "No push",
  ask: "Ask before push",
  push: "Commit + push",
};
const PUSH_SUBS = {
  none: "Edit only — no commit/push",
  ask: "Commit ok; stop before push",
  push: "Commit and push when done",
};

const render = new Poco(screen);
const fontHeader = new render.Font("Gothic-Bold", 14);
const fontTitle = new render.Font("Gothic-Bold", 14);
const fontSub = new render.Font("Gothic-Regular", 14);

const black = render.makeColor(0, 0, 0);
const white = render.makeColor(255, 255, 255);
const gray = render.makeColor(90, 90, 90);

const HOME = 0;
const NEW_AGENT = 1;
const REPO = 2;
const DETAIL = 3;
const MESSAGE = 4;

let screenName = HOME;
let previousScreen = HOME;
let statusLine = "Ready";
let busy = false;
let refreshing = false;
let phoneReady = false;
let agents = null;
let projects = null;
let selectedIndex = 0;
let selectedAgentId = null;
let selectedProject = null;
let detail = null;
let messageTitle = "Message";
let messageLines = [];
let messageScroll = 0;
let rowCount = 0;
let rowKinds = null;
let rowTitles = null;
let rowSubs = null;
let rowActions = null;
let rowIds = null;
let rowData = null;
let rowDisabled = null;
let pollTimer = null;
let dictation = null;
let dictating = false;
let pushPolicy = "none";

function ensureRowArrays(n) {
  if (rowKinds && rowKinds.length >= n) return;
  rowKinds = new Array(n);
  rowTitles = new Array(n);
  rowSubs = new Array(n);
  rowActions = new Array(n);
  rowIds = new Array(n);
  rowData = new Array(n);
  rowDisabled = new Array(n);
}

function clip(text, max) {
  text = text ? String(text) : "";
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

function statusLabel(status) {
  status = status ? String(status) : "idle";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function wrapText(text, width) {
  text = String(text || "");
  const lines = [];
  if (!text) {
    lines[0] = "(empty)";
    return lines;
  }
  // Preserve explicit newlines, then wrap each paragraph.
  const parts = text.split("\n");
  let p;
  for (p = 0; p < parts.length; p++) {
    let remaining = parts[p];
    if (!remaining) {
      lines.push("");
      continue;
    }
    while (remaining.length > width) {
      let breakAt = width;
      let i;
      for (i = width; i > width - 10 && i > 0; i--) {
        if (remaining.charAt(i) === " ") {
          breakAt = i;
          break;
        }
      }
      lines.push(remaining.slice(0, breakAt));
      remaining = remaining.slice(breakAt).replace(/^\s+/, "");
    }
    if (remaining.length) lines.push(remaining);
  }
  if (lines.length > 80) lines.length = 80;
  return lines;
}

function fullMessageText() {
  if (detail) {
    return detail.error || detail.summary || detail.activity || detail.task || "(no message)";
  }
  let existing = selectedProject ? agentForProject(selectedProject) : null;
  if (existing) return existing.activity || existing.task || "(no message)";
  return statusLine || "(no message)";
}

function openMessage(title, text) {
  previousScreen = screenName === MESSAGE ? previousScreen : screenName;
  messageTitle = title || "Message";
  messageLines = wrapText(text || "", WRAP_CHARS);
  messageScroll = 0;
  screenName = MESSAGE;
  draw();
}

function resetRows() {
  rowCount = 0;
  ensureRowArrays(20);
}

function addHeader(title) {
  ensureRowArrays(rowCount + 1);
  rowKinds[rowCount] = 0;
  rowTitles[rowCount] = title;
  rowSubs[rowCount] = "";
  rowActions[rowCount] = null;
  rowIds[rowCount] = null;
  rowData[rowCount] = null;
  rowDisabled[rowCount] = true;
  rowCount++;
}

function addCell(title, subtitle, action, id, data, disabled) {
  ensureRowArrays(rowCount + 1);
  rowKinds[rowCount] = 1;
  rowTitles[rowCount] = title;
  rowSubs[rowCount] = subtitle || "";
  rowActions[rowCount] = action || null;
  rowIds[rowCount] = id || null;
  rowData[rowCount] = data;
  rowDisabled[rowCount] = !!disabled;
  rowCount++;
}

function firstCell() {
  let i;
  for (i = 0; i < rowCount; i++) {
    if (rowKinds[i] === 1 && !rowDisabled[i]) return i;
  }
  for (i = 0; i < rowCount; i++) {
    if (rowKinds[i] === 1) return i;
  }
  return 0;
}

function moveSel(delta) {
  if (!rowCount) return;
  let idx = selectedIndex;
  let n;
  for (n = 0; n < rowCount; n++) {
    idx += delta;
    if (idx < 0) idx = rowCount - 1;
    else if (idx >= rowCount) idx = 0;
    if (rowKinds[idx] === 1) {
      selectedIndex = idx;
      return;
    }
  }
}

function agentForProject(project) {
  if (!agents || !project) return null;
  let i;
  for (i = 0; i < agents.length; i++) {
    const a = agents[i];
    if (a.projectId && a.projectId === project.id) return a;
    if (a.name === project.name) return a;
  }
  return null;
}

function buildHome() {
  resetRows();
  addHeader("Agents");
  if (!phoneReady) {
    addCell("Phone not ready", "Wait for connection", null, null, null, true);
  } else if (!agents) {
    addCell("Not loaded", "Select Refresh", null, null, null, true);
  } else if (!agents.length) {
    addCell("No agents yet", "Start one with New Task", null, null, null, true);
  } else {
    let n = agents.length > MAX_AGENTS ? MAX_AGENTS : agents.length;
    let i;
    for (i = 0; i < n; i++) {
      let a = agents[i];
      addCell(
        a.name || "Agent",
        statusLabel(a.status) + " · " + clip(a.task, 18),
        "open",
        a.id,
        null,
        false,
      );
    }
  }
  addHeader("Controls");
  addCell("Repos", "Pick a GitHub repo", "new", null, null, false);
  addCell("Refresh", statusLine, "refresh", null, null, false);
}

function projectLastAgent(project) {
  if (!project) return null;
  let fromList = agentForProject(project);
  if (fromList) return fromList;
  if (project.lastAgentId || project.lastTask) {
    return {
      id: project.lastAgentId || "",
      name: project.name,
      task: project.lastTask || "",
      status: project.lastStatus || "idle",
      activity: project.lastActivity || project.lastTask || "",
      elapsed: "",
    };
  }
  return null;
}

function buildNewAgent() {
  resetRows();
  addHeader("Repos");
  if (!projects || !projects.length) {
    addCell("No local repos", "Check daemon / phone link", null, null, null, true);
    return;
  }
  let i;
  for (i = 0; i < projects.length; i++) {
    let p = projects[i];
    let existing = projectLastAgent(p);
    let sub;
    if (existing) {
      sub =
        statusLabel(existing.status) +
        " · " +
        clip(existing.task || existing.activity, 18);
    } else if (p.ready === false) {
      sub = "Remote only";
    } else {
      sub = "Local · no agent yet";
    }
    addCell(p.name, sub, "repo", p.id, i, false);
  }
}

function buildRepo() {
  resetRows();
  let p = selectedProject;
  if (!p) {
    addHeader("Repo");
    addCell("None selected", "", null, null, null, true);
    return;
  }

  addHeader(p.name || "Repo");

  if (p.branch || p.subject || p.statusLabel) {
    addCell(
      p.branch ? p.branch + (p.head ? " @" + p.head : "") : "Git",
      p.statusLabel || (p.dirty ? "dirty" : "clean"),
      "message",
      null,
      (p.branch || "") +
        (p.head ? " @" + p.head : "") +
        "\n" +
        (p.statusLabel || "") +
        (p.subject ? "\n\nLast commit:\n" + p.subject : ""),
      false,
    );
    addCell(
      "Last commit",
      clip(p.subject || "(none)", 26),
      "message",
      null,
      p.subject || "(no commits)",
      false,
    );
  } else if (p.ready === false) {
    addCell("Not on disk", "Will clone on first start", null, null, null, true);
  } else {
    addCell("Loading git...", "Select Refresh below", null, null, null, true);
  }

  let existing = projectLastAgent(p);
  if (existing) {
    if (existing.id) {
      addCell(
        "Last agent",
        statusLabel(existing.status) +
          (existing.elapsed ? " · " + existing.elapsed : ""),
        "open",
        existing.id,
        null,
        false,
      );
    }
    addCell(
      "Last task",
      clip(existing.task || existing.activity || "", 26),
      "message",
      null,
      existing.task || existing.activity || "",
      false,
    );
  }

  addHeader("New task");
  addCell(
    "Push: " + (PUSH_LABELS[pushPolicy] || pushPolicy),
    PUSH_SUBS[pushPolicy] || "",
    "push-cycle",
    null,
    null,
    false,
  );
  addCell("Voice command", "Dictate a task for this repo", "voice", p.id, null, false);
  addCell("Refresh git", "Status + last commit", "refresh-repo", p.id, null, false);

  let presets = p.presets && p.presets.length ? p.presets : DEFAULT_PRESETS;
  addHeader("Presets");
  let i;
  for (i = 0; i < presets.length; i++) {
    addCell(clip(presets[i], 22), "Start agent", "start", p.id, presets[i], false);
  }
}

function buildDetail() {
  resetRows();
  if (!detail) {
    addHeader("Agent");
    addCell("Loading...", "Please wait", null, null, null, true);
    return;
  }
  let a = detail;
  let last = a.error || a.summary || a.activity || a.task || "";
  addHeader(a.name || "Agent");
  addCell(statusLabel(a.status), a.elapsed ? "Elapsed " + a.elapsed : "", null, null, null, true);
  addCell("Task", clip(a.task, 26), "message", null, a.task || "", false);
  addCell("Last message", clip(last, 26), "message", null, last, false);
  if (a.files) {
    addCell(a.files + " files changed", "+" + a.insertions + " / -" + a.deletions, null, null, null, true);
  }
  addHeader("Actions");
  if (a.status === "working" || a.status === "starting" || a.status === "waiting") {
    addCell("Stop Agent", "Cancel the current run", "stop", null, null, false);
  }
  if (a.needsApproval || a.status === "finished" || a.status === "waiting") {
    addCell("Approve / Continue", "Send continue to agent", "approve", null, null, false);
  }
  addCell("Refresh", "Update status now", "refresh-detail", null, null, false);
  addCell("All Agents", "Back to home", "home", null, null, false);
}

function buildRows() {
  if (screenName === HOME) buildHome();
  else if (screenName === NEW_AGENT) buildNewAgent();
  else if (screenName === REPO) buildRepo();
  else if (screenName === DETAIL) buildDetail();
  if (screenName !== MESSAGE) {
    if (selectedIndex >= rowCount || rowKinds[selectedIndex] !== 1) {
      selectedIndex = firstCell();
    }
  }
}

function statusTitle() {
  if (screenName === MESSAGE) return clip(messageTitle, 24);
  if (dictating) return "Listening...";
  if (busy || refreshing) return "Working...";
  if (statusLine && (statusLine.indexOf("Timeout") >= 0 || statusLine.indexOf("error") >= 0 || statusLine.indexOf("Error") >= 0 || statusLine.indexOf("HTTP") >= 0 || statusLine.indexOf("fail") >= 0 || statusLine.indexOf("CURSOR_API_KEY") >= 0)) {
    return clip(statusLine, 24);
  }
  if (screenName === HOME) return "PebblePilot";
  if (screenName === NEW_AGENT) return "New Agent";
  if (screenName === REPO) return selectedProject ? selectedProject.name : "Repo";
  if (screenName === DETAIL) return detail ? detail.name : "Agent";
  return "PebblePilot";
}

function drawMessage() {
  render.begin();
  render.fillRectangle(black, 0, 0, render.width, STATUS_H);
  render.drawText(clip(messageTitle, 24), fontSub, white, 6, 2);
  render.fillRectangle(white, 0, STATUS_H, render.width, render.height - STATUS_H);

  const maxLines = ((render.height - STATUS_H - 4) / LINE_H) | 0;
  let y = STATUS_H + 4;
  let i;
  for (i = 0; i < maxLines; i++) {
    const line = messageLines[messageScroll + i];
    if (line === undefined) break;
    render.drawText(line, fontSub, black, 6, y);
    y += LINE_H;
  }

  // Scroll hint
  if (messageLines.length > maxLines) {
    const hint = (messageScroll + 1) + "/" + messageLines.length;
    const w = render.getTextWidth(hint, fontSub);
    render.drawText(hint, fontSub, gray, render.width - w - 4, render.height - LINE_H);
  }
  render.end();
}

function drawMenu() {
  buildRows();
  render.begin();
  render.fillRectangle(black, 0, 0, render.width, STATUS_H);
  render.drawText(clip(statusTitle(), 24), fontSub, white, 6, 2);
  render.fillRectangle(white, 0, STATUS_H, render.width, render.height - STATUS_H);

  let avail = render.height - STATUS_H;
  let maxCells = (avail / CELL_H) | 0;
  if (maxCells < 1) maxCells = 1;

  let start = 0;
  let cellsBefore = 0;
  let i;
  for (i = 0; i < selectedIndex; i++) {
    if (rowKinds[i] === 1) cellsBefore++;
  }
  if (cellsBefore >= maxCells) {
    let keep = cellsBefore - maxCells + 1;
    for (start = 0; start < rowCount; start++) {
      if (rowKinds[start] === 1) {
        if (keep === 0) break;
        keep--;
      }
    }
    if (start > 0 && rowKinds[start - 1] === 0) start--;
  }

  let y = STATUS_H;
  let cells = 0;
  for (i = start; i < rowCount; i++) {
    if (rowKinds[i] === 0) {
      if (y + HEADER_H > render.height) break;
      render.fillRectangle(white, 0, y, render.width, HEADER_H);
      render.drawText(rowTitles[i], fontHeader, gray, 6, y + 1);
      y += HEADER_H;
    } else {
      if (cells >= maxCells || y + CELL_H > render.height) break;
      let sel = i === selectedIndex;
      render.fillRectangle(sel ? black : white, 0, y, render.width, CELL_H);
      if (!sel) render.fillRectangle(gray, 0, y + CELL_H - 1, render.width, 1);
      render.drawText(clip(rowTitles[i], 22), fontTitle, sel ? white : black, 8, y + 6);
      if (rowSubs[i]) {
        render.drawText(clip(rowSubs[i], 26), fontSub, sel ? white : gray, 8, y + 24);
      }
      y += CELL_H;
      cells++;
    }
  }
  render.end();
}

function draw() {
  if (screenName === MESSAGE) drawMessage();
  else drawMenu();
}

function goHome() {
  screenName = HOME;
  selectedIndex = 0;
  selectedAgentId = null;
  detail = null;
  draw();
}

function onRefreshDone() {
  refreshing = false;
  busy = false;
  draw();
}

function refreshAgents() {
  if (refreshing || busy || !phoneReady || screenName === MESSAGE) return;
  refreshing = true;
  draw();
  fetchAgents()
    .then(function (list) {
      agents = list || [];
      if (agents.length > MAX_AGENTS) agents.length = MAX_AGENTS;
      statusLine = agents.length + " agents";
      if (screenName === DETAIL && selectedAgentId) {
        return fetchAgent(selectedAgentId).then(function (a) {
          detail = a;
        });
      }
    })
    .catch(function (err) {
      statusLine = err.message || String(err);
    })
    .then(onRefreshDone);
}

function openNewAgent() {
  if (busy || refreshing || !phoneReady) {
    statusLine = phoneReady ? "Busy" : "Phone not ready";
    draw();
    return;
  }
  busy = true;
  statusLine = "Loading repos...";
  screenName = NEW_AGENT;
  selectedIndex = 0;
  draw();
  fetchProjects()
    .then(function (list) {
      projects = list || [];
      return fetchAgents();
    })
    .then(function (list) {
      agents = list || [];
      statusLine = projects.length + " repos";
    })
    .catch(function (err) {
      statusLine = err.message || String(err);
    })
    .then(function () {
      busy = false;
      draw();
    });
}

function applyProjectDetail(detailProject) {
  if (!detailProject || !selectedProject) return;
  selectedProject.id = detailProject.id || selectedProject.id;
  selectedProject.name = detailProject.name || selectedProject.name;
  selectedProject.ready = detailProject.ready;
  selectedProject.lastAgentId = detailProject.lastAgentId || selectedProject.lastAgentId;
  selectedProject.lastTask = detailProject.lastTask || selectedProject.lastTask;
  selectedProject.lastStatus = detailProject.lastStatus || selectedProject.lastStatus;
  selectedProject.lastActivity = detailProject.lastActivity || selectedProject.lastActivity;
  selectedProject.branch = detailProject.branch || "";
  selectedProject.head = detailProject.head || "";
  selectedProject.subject = detailProject.subject || "";
  selectedProject.dirty = !!detailProject.dirty;
  selectedProject.statusLabel = detailProject.statusLabel || "";
  selectedProject.changed = detailProject.changed || 0;
  if (selectedProject.lastAgentId) selectedAgentId = selectedProject.lastAgentId;
}

function refreshRepoDetail() {
  if (!selectedProject || !selectedProject.id || !phoneReady) return Promise.resolve();
  return fetchProject(selectedProject.id).then(function (p) {
    if (p) applyProjectDetail(p);
  });
}

function openRepo(index) {
  selectedProject = projects[index];
  let existing = projectLastAgent(selectedProject);
  selectedAgentId = existing && existing.id ? existing.id : null;
  detail = null;
  screenName = REPO;
  selectedIndex = 0;
  busy = true;
  statusLine = "Reading git...";
  draw();
  refreshRepoDetail()
    .then(function () {
      let agentId = selectedProject.lastAgentId;
      if (agentId) {
        return fetchAgent(agentId).then(function (a) {
          detail = a;
        });
      }
    })
    .catch(function (err) {
      statusLine = err.message || String(err);
    })
    .then(function () {
      busy = false;
      if (selectedProject && selectedProject.statusLabel) {
        statusLine = selectedProject.statusLabel;
      }
      draw();
    });
}

function cyclePushPolicy() {
  let i = PUSH_POLICIES.indexOf(pushPolicy);
  if (i < 0) i = 0;
  pushPolicy = PUSH_POLICIES[(i + 1) % PUSH_POLICIES.length];
  statusLine = PUSH_LABELS[pushPolicy];
  draw();
}

function openAgent(id) {
  if (busy || refreshing) return;
  selectedAgentId = id;
  busy = true;
  screenName = DETAIL;
  selectedIndex = 0;
  detail = null;
  draw();
  fetchAgent(id)
    .then(function (a) {
      detail = a;
      buildRows();
      let i;
      for (i = 0; i < rowCount; i++) {
        if (rowKinds[i] === 1 && rowActions[i] && !rowDisabled[i]) {
          selectedIndex = i;
          break;
        }
      }
    })
    .catch(function (err) {
      statusLine = err.message || String(err);
    })
    .then(function () {
      busy = false;
      draw();
    });
}

function runStart(projectId, prompt) {
  if (!projectId || !prompt || busy || refreshing || dictating) return;
  busy = true;
  statusLine = "Starting...";
  draw();
  startAgent(projectId, prompt, pushPolicy)
    .then(function (agent) {
      selectedAgentId = agent.id;
      detail = agent;
      statusLine = "Started";
      // Keep last-* fields on the selected project for the repo screen.
      if (selectedProject && selectedProject.id === projectId) {
        selectedProject.lastAgentId = agent.id;
        selectedProject.lastTask = agent.task || prompt;
        selectedProject.lastStatus = agent.status || "starting";
        selectedProject.lastActivity = agent.activity || "Starting...";
        selectedProject.ready = true;
      }
      return fetchAgents().then(function (list) {
        agents = list || [];
      });
    })
    .then(function () {
      busy = false;
      screenName = DETAIL;
      selectedIndex = 0;
      draw();
    })
    .catch(function (err) {
      statusLine = err.message || String(err);
      if (String(statusLine).indexOf("CURSOR_API_KEY") >= 0 || String(statusLine).indexOf("API key") >= 0) {
        busy = false;
        openMessage(
          "Error",
          statusLine +
            "\n\nOpen PebblePilot settings on your phone and paste your Cursor API key, then Save.",
        );
        return;
      }
      busy = false;
      draw();
    });
}

function ensureDictation() {
  if (dictation) return dictation;
  dictation = new Dictation({
    byteLength: 512,
    onReadable() {
      let text = "";
      try {
        text = String(this.read() || "").trim();
      } catch (_) {
        text = "";
      }
      dictating = false;
      if (!text) {
        statusLine = "No speech";
        busy = false;
        draw();
        return;
      }
      let projectId = selectedProject ? selectedProject.id : null;
      if (!projectId) {
        statusLine = "No repo";
        busy = false;
        draw();
        return;
      }
      statusLine = "Heard: " + clip(text, 20);
      draw();
      runStart(projectId, text);
    },
    onError(e) {
      dictating = false;
      busy = false;
      statusLine = "Mic error " + String(e);
      draw();
    },
  });
  try {
    dictation.configure({ confirm: true, errorDialogs: true });
  } catch (_) {}
  return dictation;
}

function startVoiceTask() {
  if (!selectedProject || busy || refreshing || dictating) return;
  if (!phoneReady) {
    statusLine = "Phone not ready";
    draw();
    return;
  }
  dictating = true;
  busy = true;
  statusLine = "Speak now...";
  draw();
  try {
    ensureDictation().start();
  } catch (err) {
    dictating = false;
    busy = false;
    statusLine = err.message || String(err);
    draw();
  }
}

function activate() {
  if (screenName === MESSAGE) return;
  if (busy || refreshing || dictating) return;
  if (rowKinds[selectedIndex] !== 1 || rowDisabled[selectedIndex]) return;
  let action = rowActions[selectedIndex];

  if (action === "open") openAgent(rowIds[selectedIndex]);
  else if (action === "new") openNewAgent();
  else if (action === "refresh") refreshAgents();
  else if (action === "repo") openRepo(rowData[selectedIndex]);
  else if (action === "voice") startVoiceTask();
  else if (action === "push-cycle") cyclePushPolicy();
  else if (action === "refresh-repo") {
    busy = true;
    statusLine = "Reading git...";
    draw();
    refreshRepoDetail()
      .catch(function (err) {
        statusLine = err.message || String(err);
      })
      .then(function () {
        busy = false;
        if (selectedProject && selectedProject.statusLabel) {
          statusLine = selectedProject.statusLabel;
        }
        draw();
      });
  } else if (action === "start") runStart(rowIds[selectedIndex], rowData[selectedIndex]);
  else if (action === "message") {
    openMessage(rowTitles[selectedIndex] || "Message", rowData[selectedIndex] || fullMessageText());
  } else if (action === "stop" && selectedAgentId) {
    busy = true;
    draw();
    stopAgent(selectedAgentId)
      .then(function (a) { detail = a; })
      .catch(function (err) { statusLine = err.message || String(err); })
      .then(function () { busy = false; draw(); });
  } else if (action === "approve" && selectedAgentId) {
    busy = true;
    draw();
    approveAgent(selectedAgentId, "continue")
      .then(function (a) { detail = a; })
      .catch(function (err) { statusLine = err.message || String(err); })
      .then(function () { busy = false; draw(); });
  } else if (action === "refresh-detail" && selectedAgentId) {
    busy = true;
    draw();
    fetchAgent(selectedAgentId)
      .then(function (a) { detail = a; })
      .catch(function (err) { statusLine = err.message || String(err); })
      .then(function () { busy = false; draw(); });
  } else if (action === "home") goHome();
}

function onBack() {
  if (screenName === MESSAGE) {
    screenName = previousScreen;
    draw();
    return;
  }
  if (screenName === DETAIL) {
    if (selectedProject) {
      screenName = REPO;
      selectedIndex = 0;
      draw();
    } else goHome();
  } else if (screenName === REPO) {
    screenName = NEW_AGENT;
    selectedIndex = 0;
    draw();
  } else if (screenName === NEW_AGENT) goHome();
}

function onUp() {
  if (screenName === MESSAGE) {
    if (messageScroll > 0) {
      messageScroll--;
      draw();
    }
    return;
  }
  moveSel(-1);
  draw();
}

function onDown() {
  if (screenName === MESSAGE) {
    const maxLines = ((render.height - STATUS_H - 4) / LINE_H) | 0;
    if (messageScroll + maxLines < messageLines.length) {
      messageScroll++;
      draw();
    }
    return;
  }
  moveSel(1);
  draw();
}

new Button({
  types: ["select", "up", "down", "back"],
  single: true,
  onPush(down, type) {
    if (!down) return;
    if (type === "select") activate();
    else if (type === "up") onUp();
    else if (type === "down") onDown();
    else if (type === "back") onBack();
  },
});

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(function () {
    if (!phoneReady) return;
    if (screenName === HOME || screenName === DETAIL || screenName === REPO) refreshAgents();
  }, POLL_MS);
}

draw();
startPolling();

initApi(function () {
  phoneReady = true;
  statusLine = "Phone ready";
  draw();
  refreshAgents();
});
