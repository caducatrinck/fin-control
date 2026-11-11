import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Raiz do projeto (onde ficam `.env`, `data/` e `src/`).
 * No Electron empacotado, defina `FIN_CONTROL_ROOT` antes de subir o servidor.
 */
export function projectRoot(): string {
  if (process.env.FIN_CONTROL_ROOT) return process.env.FIN_CONTROL_ROOT;
  return fileURLToPath(new URL("..", import.meta.url));
}

export function envFilePath(): string {
  return path.join(projectRoot(), ".env");
}

export function dataDir(): string {
  return path.join(projectRoot(), "data");
}

export function srcDir(): string {
  return path.join(projectRoot(), "src");
}
