import { startServer } from "../web/server.mjs";

let application;
let shuttingDown = false;

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  try {
    if (application) await application.close();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[desktop-runner] Shutdown failed: ${message}`);
    process.exitCode = 1;
    return;
  }

  process.exitCode = exitCode;
}

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
  process.stdout.write(`${JSON.stringify({ type: "startup-error", message })}\n`);
  process.stdout.flush?.();
  process.exitCode = 1;
});
