// Carregado no <head> como script clássico (sem defer), para aplicar o tema antes da renderização.

type ThemePreference = "system" | "light" | "dark";
type Theme = Exclude<ThemePreference, "system">;

(() => {
  const KEY = "fin-control:theme";
  const media = matchMedia("(prefers-color-scheme: dark)");
  const LABELS: Record<ThemePreference, string> = { system: "◐ Auto", light: "☀ Claro", dark: "☾ Escuro" };
  const NEXT: Record<ThemePreference, ThemePreference> = { system: "light", light: "dark", dark: "system" };

  const isPreference = (value: string | null): value is ThemePreference =>
    value === "system" || value === "light" || value === "dark";

  const preference = (): ThemePreference => {
    const stored = localStorage.getItem(KEY);
    return isPreference(stored) ? stored : "system";
  };

  const resolve = (pref: ThemePreference): Theme => (pref === "system" ? (media.matches ? "dark" : "light") : pref);

  function apply(): void {
    const pref = preference();
    document.documentElement.dataset.theme = resolve(pref);
    for (const btn of document.querySelectorAll<HTMLElement>("[data-theme-toggle]")) {
      btn.textContent = LABELS[pref];
      btn.title = "Alternar tema (automático, claro, escuro)";
    }
  }

  media.addEventListener("change", apply);
  document.addEventListener("click", (e) => {
    if (!(e.target instanceof Element) || !e.target.closest("[data-theme-toggle]")) return;
    localStorage.setItem(KEY, NEXT[preference()]);
    apply();
  });
  document.addEventListener("DOMContentLoaded", apply);
  apply();
})();
