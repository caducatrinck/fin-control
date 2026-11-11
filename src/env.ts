import { readFile, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { envFilePath } from "./paths.ts";

export const ENV_KEYS = ["PLUGGY_CLIENT_ID", "PLUGGY_CLIENT_SECRET", "PLUGGY_ITEM_ID"] as const;

export type EnvKey = (typeof ENV_KEYS)[number];

export type AppEnv = Partial<Record<EnvKey, string>>;

export async function readEnv(): Promise<AppEnv> {
  const content = await readFile(envFilePath(), "utf8").catch(() => "");
  const parsed = parseEnv(content);
  const env: AppEnv = {};
  for (const key of ENV_KEYS) {
    const value = parsed[key];
    if (value) env[key] = value;
  }
  return env;
}

export async function updateEnv(values: AppEnv): Promise<void> {
  let content = await readFile(envFilePath(), "utf8").catch(() => "");
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value ?? ""}`;
    const pattern = new RegExp(`^${key}=.*$`, "m");
    content = pattern.test(content) ? content.replace(pattern, line) : `${content.trimEnd()}\n${line}\n`;
  }
  await writeFile(envFilePath(), content.trimStart());
}
