import { app, BrowserWindow, dialog, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Em dev: raiz do repo. Empacotado: userData (gravável para `.env` e `data/`). */
function resolveDataRoot(): string {
  if (app.isPackaged) return app.getPath("userData");
  return path.resolve(__dirname, "../..");
}

process.env.FIN_CONTROL_ROOT ??= resolveDataRoot();
// Porta dedicada ao desktop (evita conflito com `npm start` na 3000).
process.env.PORT ??= "18765";

const { startServer, stopServer } = await import("../server.ts");

let mainWindow: BrowserWindow | null = null;
let appUrl = "";

async function createWindow(url: string): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: "Fin Control",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Links externos só em https, no navegador padrão; a janela nunca sai do app local.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith("https://")) void shell.openExternal(target);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, target) => {
    if (!target.startsWith(url)) event.preventDefault();
  });

  await mainWindow.loadURL(url);
}

async function boot(): Promise<void> {
  const { url } = await startServer({ openBrowser: false });
  appUrl = url;
  await createWindow(url);
}

app.whenReady().then(async () => {
  try {
    await boot();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    dialog.showErrorBox("Fin Control", `Não foi possível iniciar.\n\n${message}`);
    app.quit();
    return;
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && appUrl) void createWindow(appUrl);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  void stopServer();
});
