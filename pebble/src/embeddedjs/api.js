import Message from "pebble/message";

const CMD = {
  PROJECTS: 1,
  AGENTS: 2,
  AGENT: 3,
  START: 4,
  STOP: 5,
  APPROVE: 6,
};

let bus = null;
let writable = false;
let pending = null;
let queue = [];

function clearPendingTimer(item) {
  if (item && item.timer) {
    clearTimeout(item.timer);
    item.timer = null;
  }
}

function failPending(err) {
  const p = pending;
  pending = null;
  if (!p) {
    pump();
    return;
  }
  clearPendingTimer(p);
  p.reject(err);
  pump();
}

function resolvePending(payload) {
  const p = pending;
  pending = null;
  if (!p) {
    pump();
    return;
  }
  clearPendingTimer(p);
  p.resolve(payload);
  pump();
}

function pump() {
  if (pending || !writable || !queue.length || !bus) return;
  const next = queue.shift();
  pending = next;
  next.timer = setTimeout(function () {
    if (pending === next) failPending(new Error("Timeout"));
  }, 15000);
  try {
    bus.write(
      new Map([
        ["CMD", next.cmd],
        ["ARG", next.arg || ""],
        ["DATA", next.data || ""],
      ]),
    );
  } catch (err) {
    failPending(err instanceof Error ? err : new Error(String(err)));
  }
}

function call(cmd, arg, data) {
  return new Promise(function (resolve, reject) {
    queue.push({
      cmd: cmd,
      arg: arg || "",
      data: data || "",
      resolve: resolve,
      reject: reject,
      timer: null,
    });
    pump();
  });
}

export function initApi(onReady) {
  bus = new Message({
    keys: ["CMD", "ARG", "DATA", "STATUS", "PAYLOAD"],
    onReadable() {
      const msg = this.read();
      let status = 0;
      let payloadText = "{}";
      msg.forEach(function (value, key) {
        if (key === "STATUS") status = value;
        else if (key === "PAYLOAD") payloadText = value;
      });
      let payload = {};
      try {
        payload = JSON.parse(payloadText || "{}");
      } catch (_) {
        payload = { error: "Bad JSON" };
      }
      if (!pending) return;
      if (!status) {
        failPending(new Error(payload.error || "Request failed"));
        return;
      }
      resolvePending(payload);
    },
    onWritable() {
      writable = true;
      if (onReady) onReady();
      pump();
    },
    onSuspend() {
      writable = false;
    },
  });
}

export function fetchProjects() {
  return call(CMD.PROJECTS).then(function (p) {
    return p.projects || [];
  });
}

export function fetchAgents() {
  return call(CMD.AGENTS).then(function (p) {
    return p.agents || [];
  });
}

export function fetchAgent(id) {
  return call(CMD.AGENT, id).then(function (p) {
    return p.agent;
  });
}

export function startAgent(projectId, prompt) {
  return call(CMD.START, projectId, prompt).then(function (p) {
    return p.agent;
  });
}

export function stopAgent(id) {
  return call(CMD.STOP, id).then(function (p) {
    return p.agent;
  });
}

export function approveAgent(id, choice) {
  return call(CMD.APPROVE, id, choice || "continue").then(function (p) {
    return p.agent;
  });
}
