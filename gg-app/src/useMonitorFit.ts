import { useEffect } from "react";

/**
 * In World's in-game computer the app keeps its full-window layout and is
 * scaled into the space between World's top bar and Stand up
 * (.app-in-monitor reads --mon-tf). Extracted from App.tsx.
 */
export function useMonitorFit(monitorOpen: boolean): void {
  useEffect(() => {
    if (!monitorOpen) return;
    const root = document.documentElement;
    const fit = (): void => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const top = 52;
      const bottom = 64;
      const k = Math.max(0.5, Math.min((w - 40) / w, (h - top - bottom) / h));
      // scaled about the window's centre (.app-in-monitor's transform-origin), then shifted into the free band
      const dy = top + (h - top - bottom - k * h) / 2 - (h - k * h) / 2;
      root.style.setProperty("--mon-tf", `translateY(${dy.toFixed(1)}px) scale(${k.toFixed(4)})`);
    };
    fit();
    window.addEventListener("resize", fit);
    return () => {
      window.removeEventListener("resize", fit);
      root.style.removeProperty("--mon-tf");
    };
  }, [monitorOpen]);
}
