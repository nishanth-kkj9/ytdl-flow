const parentPort = process.parentPort;

if (!parentPort) {
  throw new Error("The backend runner must be started by Electron utilityProcess.");
}

let application;
let closing = false;

async function closeBackend() {
  if (closing) return;
  closing = true;
  try {
    await application?.close();
    parentPort.postMessage({ type: "stopped" });
  } catch (error) {
    parentPort.postMessage({
      type: "shutdown-error",
      message: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  } finally {
    parentPort.close();
  }
}

try {
  const { startServer } = await import("../web/server.mjs");
  const requestedPort = Number(process.argv[2]);
  application = await startServer({
    port: Number.isInteger(requestedPort) && requestedPort >= 0 ? requestedPort : 0,
    host: "127.0.0.1",
    logStartup: false,
  });

  const health = await fetch(`${application.address}/api/health`);
  if (!health.ok) {
    throw new Error(`Backend health check returned HTTP ${health.status}`);
  }
  parentPort.postMessage({ type: "ready", address: application.address });
  parentPort.on("message", ({ data }) => {
    if (data?.type === "shutdown") void closeBackend();
  });
} catch (error) {
  let startupError = error;
  try {
    await application?.close();
  } catch (cleanupError) {
    const startupMessage = error instanceof Error ? error.message : String(error);
    const cleanupMessage =
      cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    startupError = new Error(
      `Backend startup failed (${startupMessage}) and cleanup failed (${cleanupMessage}).`,
      { cause: new AggregateError([error, cleanupError]) },
    );
  }
  parentPort.postMessage({
    type: "startup-error",
    message: startupError instanceof Error ? startupError.message : String(startupError),
  });
  parentPort.close();
  process.exitCode = 1;
}
