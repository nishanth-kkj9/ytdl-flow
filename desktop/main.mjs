import { app, BrowserWindow, dialog, ipcMain, shell, utilityProcess } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const settingsFile = path.join(app.getPath("userData"), "settings.json");
const singleInstance = app.requestSingleInstanceLock();

let mainWindow;
let backend;
let backendAddress;
let backendPort;
const backendExitPromises = new WeakMap();
let downloadDirectory;
let backendStopping = false;
let quitting = false;

function copyEnvironmentValue(target, name) {
  const value = process.env[name];
  if (value !== undefined) target[name] = value;
}

function backendEnvironment(port) {
  const env = {};
  for (const name of [
    "PATH",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "PATHEXT",
    "COMSPEC",
    "HOME",
    "FFMPEG_PATH",
    "FFMPEG_HOME",
    "DENO_PATH",
    "YTDL_COOKIES_FILE",
    "YTDL_COOKIES_BROWSER",
    "ENGINE_MAX_PENDING",
    "PYTHON",
  ]) {
    copyEnvironmentValue(env, name);
  }

  const appPath = app.getAppPath();
  const userData = app.getPath("userData");
  env.NODE_ENV = "production";
  env.HOST = "127.0.0.1";
  env.PORT = String(port || 3000);
  env.YTDL_DIST_DIR = path.join(appPath, "dist");
  env.YTDL_DATA_DIR = path.join(userData, "data");
  env.YTDL_DOWNLOADS_DIR = downloadDirectory;
  env.YTDL_LOG_DIR = path.join(userData, "logs");

  if (app.isPackaged) {
    const engineDir = path.join(process.resourcesPath, "engine");
    const engineExe = path.join(engineDir, "ytdl-flow-engine.exe");
    env.YTDL_ENGINE_ENTRY = engineExe;
    env.YTDL_ENGINE_CWD = engineDir;
    env.YTDL_ENGINE_EXECUTABLE = engineExe;
  } else {
    const engineDir = path.resolve(appPath, "python-engine");
    env.YTDL_ENGINE_ENTRY = path.join(engineDir, "ipc_main.py");
    env.YTDL_ENGINE_CWD = engineDir;
  }

  return env;
}

async function persistSettings(directory) {
  const temporaryFile = `${settingsFile}.${process.pid}.tmp`;
  await fs.writeFile(
    temporaryFile,
    `${JSON.stringify({ downloadDirectory: directory }, null, 2)}\n`,
    "utf8",
  );
  await fs.rename(temporaryFile, settingsFile);
}

async function loadSettings() {
  await fs.mkdir(path.dirname(settingsFile), { recursive: true });
  try {
    const parsed = JSON.parse(await fs.readFile(settingsFile, "utf8"));
    if (
      typeof parsed.downloadDirectory !== "string" ||
      !path.isAbsolute(parsed.downloadDirectory)
    ) {
      throw new Error("The saved download directory is not an absolute path.");
    }
    downloadDirectory = path.resolve(parsed.downloadDirectory);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new Error(`Could not read desktop settings: ${error.message}`, { cause: error });
    }
    downloadDirectory = path.join(app.getPath("downloads"), "YTDL Flow");
  }
  await fs.mkdir(downloadDirectory, { recursive: true });
  downloadDirectory = await fs.realpath(downloadDirectory);
  await persistSettings(downloadDirectory);
}

function waitForExit(exitPromise, timeoutMs) {
  let timer;
  return Promise.race([
    exitPromise.then(() => true),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function stopBackend() {
  const current = backend;
  if (!current) return;
  backendStopping = true;
  current.postMessage({ type: "shutdown" });
  const exitPromise = backendExitPromises.get(current);

  if (!(await waitForExit(exitPromise, 10_000))) {
    current.kill();
    if (!(await waitForExit(exitPromise, 2_000))) {
      throw new Error("The backend process did not exit after termination.");
    }
  }
  if (backend === current) backend = null;
  backendAddress = undefined;
  backendPort = undefined;
}

function validateBackendAddress(value) {
  let address;
  try {
    address = new URL(value);
  } catch {
    throw new Error("The backend returned an invalid address.");
  }
  if (
    address.protocol !== "http:" ||
    address.hostname !== "127.0.0.1" ||
    !address.port ||
    address.username ||
    address.password ||
    address.pathname !== "/" ||
    address.search ||
    address.hash
  ) {
    throw new Error("The backend returned an address outside the localhost boundary.");
  }
  return address;
}

function startBackend(port = 0) {
  backendStopping = false;
  const child = utilityProcess.fork(
    path.join(__dirname, "backend-runner.mjs"),
    [String(port)],
    {
      cwd: app.getPath("userData"),
      env: backendEnvironment(port),
      serviceName: "YTDL Flow Backend",
      stdio: "ignore",
    },
  );
  let resolveExit;
  const exitPromise = new Promise((resolve) => {
    resolveExit = resolve;
  });
  backendExitPromises.set(child, exitPromise);
  backend = child;

  return new Promise((resolve, reject) => {
    let settled = false;
    let startupTimer;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      backendStopping = true;
      clearTimeout(startupTimer);
      child.kill();
      void waitForExit(exitPromise, 2_000).then((exited) => {
        if (backend === child) backend = null;
        reject(
          exited
            ? error
            : new AggregateError(
                [error, new Error("The failed backend process did not exit.")],
                "Backend startup and cleanup failed.",
              ),
        );
      });
    };

    startupTimer = setTimeout(() => {
      fail(new Error("The local backend did not become ready in time."));
    }, 30_000);

    child.on("message", ({ data }) => {
      if (data?.type === "startup-error") {
        fail(new Error(`The local backend failed to start: ${data.message}`));
        return;
      }
      if (data?.type === "shutdown-error") {
        console.error("[desktop] Backend shutdown failed:", data.message);
        return;
      }
      if (data?.type !== "ready" || settled) return;

      try {
        const address = validateBackendAddress(data.address);
        settled = true;
        clearTimeout(startupTimer);
        backendAddress = address.origin;
        backendPort = Number(address.port);
        resolve(address.origin);
      } catch (error) {
        fail(error);
      }
    });

    child.once("error", (error) => {
      clearTimeout(startupTimer);
      fail(new Error(`Could not launch the local backend: ${error.message}`, { cause: error }));
    });

    child.once("exit", (code) => {
      clearTimeout(startupTimer);
      resolveExit();
      if (backend === child) backend = null;
      if (!settled) {
        settled = true;
        reject(new Error(`The local backend exited before readiness (code ${code}).`));
      } else if (!backendStopping && !quitting) {
        backendAddress = undefined;
        backendPort = undefined;
        void dialog.showMessageBox({
          type: "error",
          title: "YTDL Flow backend stopped",
          message: "The local backend stopped unexpectedly. The application will close.",
        }).then(
          () => app.quit(),
          (error) => {
            console.error("[desktop] Could not show backend failure dialog:", error);
            app.quit();
          },
        );
      }
    });
  });
}

function createWindow(address) {
  const localOrigin = new URL(address).origin;
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, "branding", "ytdl-flow-icon.ico")
    : path.join(app.getAppPath(), "public", "branding", "ytdl-flow-icon.ico");
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 760,
    minHeight: 620,
    backgroundColor: "#08080D",
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  mainWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url);
      if (target.origin === localOrigin) return { action: "allow" };
      if (target.protocol === "https:") {
        void shell.openExternal(target.href).catch((error) => {
          console.error("[desktop] Could not open external URL:", error);
        });
      }
    } catch (error) {
      console.error("[desktop] Rejected invalid window URL:", error);
    }
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    try {
      if (new URL(url).origin !== localOrigin) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });
  mainWindow.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });
  void mainWindow.loadURL(localOrigin).catch((error) => {
    console.error("[desktop] Could not load the local application:", error);
    dialog.showErrorBox("YTDL Flow could not open", error.message);
    app.quit();
  });
}

function assertTrustedSender(event) {
  let senderOrigin;
  try {
    senderOrigin = new URL(event.senderFrame?.url ?? "").origin;
  } catch {
    throw new Error("Untrusted renderer cannot request a native dialog.");
  }
  if (
    !mainWindow ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== mainWindow.webContents.mainFrame ||
    !backendAddress ||
    senderOrigin !== backendAddress
  ) {
    throw new Error("Untrusted renderer cannot request a native dialog.");
  }
}

async function chooseDownloadDirectory(event) {
  assertTrustedSender(event);
  const selection = await dialog.showOpenDialog(mainWindow, {
    title: "Choose download folder",
    defaultPath: downloadDirectory,
    properties: ["openDirectory", "createDirectory"],
  });
  if (selection.canceled || selection.filePaths.length === 0) {
    return { status: "cancelled" };
  }

  const candidate = await fs.realpath(selection.filePaths[0]);
  const details = await fs.stat(candidate);
  if (!details.isDirectory()) {
    throw new Error("The selected download location is not a directory.");
  }
  if (candidate === downloadDirectory) {
    return { status: "unchanged", path: candidate };
  }

  const statusResponse = await fetch(`${backendAddress}/api/status`);
  if (!statusResponse.ok) {
    throw new Error(`Could not verify active downloads (HTTP ${statusResponse.status}).`);
  }
  const status = await statusResponse.json();
  if (status.engineReady !== true) {
    throw new Error("The engine must be ready before changing the download folder.");
  }
  if (!Array.isArray(status.activeJobs)) {
    throw new Error("The backend returned an invalid active-download status.");
  }
  if (status.activeJobs.length > 0) {
    return {
      status: "blocked",
      message: "Finish or cancel active downloads before changing the download folder.",
    };
  }

  const previousDirectory = downloadDirectory;
  const previousPort = backendPort;
  await stopBackend();
  downloadDirectory = candidate;
  try {
    await persistSettings(downloadDirectory);
    await startBackend(previousPort);
    return { status: "updated", path: downloadDirectory };
  } catch (error) {
    downloadDirectory = previousDirectory;
    await persistSettings(previousDirectory);
    if (backend) await stopBackend();
    await startBackend(previousPort);
    throw new Error(`Could not change the download folder: ${error.message}`, { cause: error });
  }
}

ipcMain.handle("settings:choose-download-directory", chooseDownloadDirectory);

if (!singleInstance) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void stopBackend()
      .catch((error) => {
        console.error("[desktop] Could not stop backend cleanly:", error);
      })
      .finally(() => app.quit());
  });

  app.on("window-all-closed", () => app.quit());

  app.whenReady().then(async () => {
    if (app.isPackaged && (process.platform !== "win32" || process.arch !== "x64")) {
      throw new Error("The packaged YTDL Flow desktop app requires 64-bit Windows.");
    }
    app.setAppUserModelId("com.ytdlflow.app");
    await loadSettings();
    const address = await startBackend();
    createWindow(address);
  }).catch((error) => {
    console.error("[desktop] Startup failed:", error);
    dialog.showErrorBox("YTDL Flow could not start", error.message);
    app.quit();
  });
}
