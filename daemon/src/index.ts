import { loadConfig, resolveApiKey } from "./config.js";
import { CursorBridge } from "./cursor.js";
import { NotificationBus } from "./notifications.js";
import { ProjectRegistry } from "./projects.js";
import { SessionManager } from "./sessions.js";
import { startServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  let apiKey = "";
  try {
    apiKey = resolveApiKey(config);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[pebblepilot] ${message}`);
    console.warn("[pebblepilot] Daemon will serve status APIs; starting agents requires the key.");
  }
  const projects = new ProjectRegistry(config);
  const bus = new NotificationBus();
  const cursor = new CursorBridge(apiKey, config.defaultModel);
  const sessions = new SessionManager(projects, cursor, bus);
  const server = startServer(config, projects, sessions, bus, cursor);

  const shutdown = async (signal: string) => {
    console.log(`[pebblepilot] received ${signal}, shutting down...`);
    await server.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[pebblepilot] fatal:", err);
  process.exit(1);
});
