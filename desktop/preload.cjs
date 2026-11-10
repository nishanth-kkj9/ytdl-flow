const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ytdlDesktop", {
  chooseDownloadDirectory: () =>
    ipcRenderer.invoke("settings:choose-download-directory"),
});
