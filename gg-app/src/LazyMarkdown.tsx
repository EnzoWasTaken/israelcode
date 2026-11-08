import { lazy, useEffect, useState, type ComponentProps, type ReactElement } from "react";
import type { Markdown as MarkdownImpl } from "./Markdown";

// The markdown renderer (react-markdown, remark/rehype, highlight.js) loads on
// demand: Home never shows markdown. main.tsx preloads it on idle after first
// paint, so a transcript is almost always rendered with it already here; until
// then the transcript's Suspense boundary shows its skeleton, never raw text.
type MarkdownComponent = typeof MarkdownImpl;
const load = () => import("./Markdown");
let pending: ReturnType<typeof load> | null = null;
let loaded: MarkdownComponent | null = null;

export function preloadMarkdown(): ReturnType<typeof load> {
  pending ??= load().then((module) => {
    loaded = module.Markdown;
    return module;
  });
  return pending;
}

/**
 * True once the renderer is here; starts loading it otherwise. The transcript
 * holds its rows (showing the skeleton) until then, so a row never mounts
 * against a placeholder: its one-time entrance plays once, on real content.
 */
export function useMarkdownReady(): boolean {
  const [ready, setReady] = useState(() => loaded !== null);
  useEffect(() => {
    if (ready) return;
    let live = true;
    void preloadMarkdown().then(() => {
      if (live) setReady(true);
    });
    return () => {
      live = false;
    };
  }, [ready]);
  return ready;
}

const LazyMarkdown = lazy(() => preloadMarkdown().then((module) => ({ default: module.Markdown })));

export function Markdown(props: ComponentProps<MarkdownComponent>): ReactElement {
  // Pick once per instance so a row never remounts its markdown on load.
  const [Component] = useState<MarkdownComponent | typeof LazyMarkdown>(
    () => loaded ?? LazyMarkdown,
  );
  return <Component {...props} />;
}
