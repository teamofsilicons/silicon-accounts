"use client";

/**
 * The dev tools panel (dev-states.tsx), loaded only in development. A static import from the layout put the panel, both
 * inspectors, the type lab and the fake data into every production page's entry chunks even though they never render;
 * behind this check the bundler drops the import from production builds.
 */
import dynamic from "next/dynamic";

const Panel = process.env.NODE_ENV === "development"
  ? dynamic(() => import("./dev-states").then(module => module.DevStatesPanel), { ssr: false })
  : () => null;

export function DevTools() {
  return <Panel />;
}
