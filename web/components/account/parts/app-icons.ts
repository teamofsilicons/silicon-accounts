/**
 * Anil's app icons for the Team of Silicons apps (2026-11-10, public/icons/<app>/: web, iOS and Android sets). Home
 * uses the iOS 180px square (full bleed, so AppMark's squircle clips it like an app icon). An experiment: the API's
 * logo_url still wins everywhere else.
 */
const ICONS: Record<string, string> = {
  briefcase: "/icons/briefcase/ios/AppIcon@3x.png",
  dm: "/icons/dm/ios/AppIcon@3x.png",
  ting: "/icons/ting/ios/AppIcon@3x.png",
  write: "/icons/write/ios/AppIcon@3x.png",
  "silicon-writings": "/icons/writings/ios/AppIcon@3x.png",
};

/** The app with Anil's icon as its logo (light and dark), when there is one. */
export function withAppIcon<T extends { app_id: string; logo_url: string | null; logo_dark_url?: string | null }>(app: T): T {
  const icon = ICONS[app.app_id];
  return icon ? { ...app, logo_url: icon, logo_dark_url: icon } : app;
}
