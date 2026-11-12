import { startServer } from "../web/server.mjs";
import readline from "node:readline";

let application;
let shutdownPromise;
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function shutdown(exitCode = 0) {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    try {
      if (application) await application.close();
      process.exitCode = exitCode;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[desktop-runner] Shutdown failed: ${message}`);
      process.exitCode = 1;
    } finally {
      input.close();
    }
  })();
  return shutdownPromise;
}

input.on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch (error) {
    console.error("[desktop-runner] Ignoring malformed stdin request:", error);
    return;
  }
  if (request?.type === "shutdown") {
    void shutdown();
  } else {
    console.error("[desktop-runner] Ignoring unknown stdin request.");
  }
});
input.on("close", () => {
  if (application) void shutdown();
});

process.stdin.on("error", (error) => {
  console.error("[desktop-runner] Stdin error:", error instanceof Error ? error.message : String(error));
});

process.on("unhandledRejection", (reason) => {
  console.error("[desktop-runner] Unhandled rejection:", reason instanceof Error ? reason.message : String(reason));
});

process.on("uncaughtException", (error) => {
  console.error("[desktop-runner] Uncaught exception:", error instanceof Error ? error.message : String(error));
  void shutdown(1);
});

async function main() {
  const requestedPort = Number(process.argv[2] ?? process.env.PORT ?? 0);
  application = await startServer({
    port: Number.isInteger(requestedPort) && requestedPort >= 0 ? requestedPort : 0,
    host: "127.0.0.1",
    logStartup: false,
  });

  process.stdout.write(`${JSON.stringify({ type: "ready", address: application.address })}\n`);
  process.stdout.flush?.();

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[desktop-runner] Startup failed: ${message}`);
  process.stdout.write(`${JSON.stringify({ type: "startup-error", message })}\n`);
  process.stdout.flush?.();
  process.exitCode = 1;
  input.close();
});
