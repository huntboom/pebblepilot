import type { IncomingMessage } from "node:http";
import type { AppConfig } from "./types.js";

export function extractBearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  return token;
}

export function isAuthorized(req: IncomingMessage, config: AppConfig): boolean {
  const token = extractBearerToken(req);
  if (!token) {
    const queryToken = new URL(req.url ?? "/", `http://${req.headers.host}`).searchParams.get(
      "token",
    );
    return queryToken === config.token;
  }
  return token === config.token;
}
