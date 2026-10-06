/**
 * The layout of one app's developer pages (web-developer area): it stays mounted while the tab below it changes, so
 * the app, its sign-in setup draft and the tab frame survive tab switches (components/developer/app/app-scope.tsx).
 */
import { AppScope } from "@/components/developer/app/app-scope";

/** Route params arrive percent-encoded when they hold reserved characters; a malformed one stays as written. */
function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export default async function Layout({ children, params }: LayoutProps<"/developer/[appId]">) {
  const { appId } = await params;
  return <AppScope appId={decode(appId)}>{children}</AppScope>;
}
