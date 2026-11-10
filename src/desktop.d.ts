interface DesktopDirectoryResult {
  status: "cancelled" | "unchanged" | "updated" | "blocked";
  path?: string;
  message?: string;
}

interface YtdlDesktopApi {
  chooseDownloadDirectory: () => Promise<DesktopDirectoryResult>;
}

declare global {
  interface Window {
    ytdlDesktop?: YtdlDesktopApi;
  }
}

export {};
