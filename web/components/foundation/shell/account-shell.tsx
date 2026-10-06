"use client";

/**
 * The account site's frame for signed-in pages: the top row (brand, search), the page, the floating dock, the ⌘K
 * palette, number-key section shortcuts and page transitions. It also guards the account routes: visitors without a
 * session are sent to sign in and come back to the page they asked for. At "/" a signed-out visitor sees the landing
 * page, rendered bare (without the shell).
 */
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ViewTransition, useCallback, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { LogOut, Monitor, Moon, Search, Settings as SettingsIcon, Sun, SwatchBook } from "lucide-react";
import { Alert } from "@/components/arc/alert/alert";
import { Button } from "@/components/arc/button/button";
import { SkeletonBlock } from "@/components/foundation/feedback/skeleton-block";
import { changeTheme } from "@/lib/theme";
import { openCommandPalette, toggleCommandPalette, useCommandPaletteOpen, useRegisterCommands } from "@/lib/commands";
import { SECTIONS, navigationType, paths, sectionFor } from "@/lib/navigation";
import { notify, notifyError } from "@/lib/notify";
import { beginSignIn, consumeSignInReturn, useMe, useRefreshSession, useSession, useSignOut } from "@/lib/query/session";
import { BrandMark } from "./brand-mark";
import { CommandMenu } from "./command-menu";
import { Dock, type DockAccount } from "./dock";
import styles from "./shell.module.css";

const subscribeNothing = () => () => undefined;

function detectApple(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /mac|iphone|ipad|ipod/i.test(nav.userAgentData?.platform ?? nav.platform ?? "");
}

/** True when the event target is a text field, so global shortcuts never steal keys from typing. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.tagName === "TEXTAREA" || target.tagName === "SELECT") return true;
  if (target.tagName !== "INPUT") return false;
  return !["button", "checkbox", "radio", "submit", "reset", "range", "color", "file"].includes((target as HTMLInputElement).type);
}

/** The loading stand-in for a page: header and two regions in their final positions. */
export function PageSkeleton() {
  return (
    <div className={styles.loading} aria-busy="true" aria-label="Loading">
      <div className={styles.loadingHeader}>
        <SkeletonBlock width="min(320px, 70%)" height="44px" radius="12px" />
        <SkeletonBlock width="min(480px, 90%)" height="18px" radius="8px" index={1} />
      </div>
      <SkeletonBlock width="100%" height="220px" radius="var(--radius-surface)" index={2} />
      <SkeletonBlock width="100%" height="140px" radius="var(--radius-surface)" index={3} />
    </div>
  );
}

const PAGE_CLASSES = { "nav-forward": "page-forward", "nav-back": "page-back", "nav-fade": "page-fade", default: "page-fade" };

export function AccountShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { status, session, error, refetch } = useSession();
  const me = useMe();
  const refreshSession = useRefreshSession();
  const { signOut } = useSignOut();
  const paletteOpen = useCommandPaletteOpen();
  const isApple = useSyncExternalStore(subscribeNothing, detectApple, () => false);
  const isHome = pathname === "/";
  const active = sectionFor(pathname);

  // The end of a first-party sign-in (/?code&state): put the saved path back, then show it. Until the router has
  // left this URL the page shows its skeleton (read from the address, so nothing flashes on the way).
  const search = useSearchParams();
  const returning = isHome && !!search.get("state") && (!!search.get("code") || !!search.get("error"));
  useEffect(() => {
    if (!returning) return;
    const result = consumeSignInReturn();
    if (!result) return;
    if (result.error) {
      notify.info("Sign-in did not finish", result.error === "access_denied" ? "You cancelled it. Sign in again whenever you are ready." : `The sign-in ended with "${result.error}". Try again.`);
    }
    void refreshSession().finally(() => router.replace(result.path));
  }, [returning, refreshSession, router]);

  // Account routes need a session; "/" shows the landing page instead.
  useEffect(() => {
    if (status === "signed_out" && !isHome && !returning) beginSignIn(window.location.pathname + window.location.search);
  }, [status, isHome, returning]);

  /** Navigates inside a page transition whose direction follows the dock. */
  const go = useCallback((href: string) => {
    if (href === pathname) return;
    router.push(href, { transitionTypes: [navigationType(pathname, href)] });
  }, [pathname, router]);

  const doSignOut = useCallback(async () => {
    try {
      await signOut();
    } catch (failure) {
      notifyError(failure, "Could not sign out");
    }
  }, [signOut]);

  // Commands every account page has.
  useRegisterCommands(() => [
    ...SECTIONS.map(section => {
      const Icon = section.icon;
      return {
        id: `go.${section.key}`,
        label: section.label,
        description: section.description,
        group: "Go to",
        shortcut: section.shortcut,
        icon: <Icon size={16} strokeWidth={1.75} />,
        keywords: [section.key, "go", "open"],
        run: () => go(section.href),
      };
    }),
    { id: "go.settings", label: "Settings", description: "Theme, telemetry, sessions and your account", group: "Go to", icon: <SettingsIcon size={16} strokeWidth={1.75} />, keywords: ["preferences", "delete", "sessions"], run: () => go(paths.settings) },
    { id: "theme.light", label: "Use the light theme", group: "Appearance", icon: <Sun size={16} strokeWidth={1.75} />, keywords: ["theme", "light", "appearance"], run: () => changeTheme("light", null) },
    { id: "theme.dark", label: "Use the dark theme", group: "Appearance", icon: <Moon size={16} strokeWidth={1.75} />, keywords: ["theme", "dark", "appearance", "night"], run: () => changeTheme("dark", null) },
    { id: "theme.system", label: "Match the device theme", group: "Appearance", icon: <Monitor size={16} strokeWidth={1.75} />, keywords: ["theme", "system", "auto", "appearance"], run: () => changeTheme("system", null) },
    ...(process.env.NODE_ENV !== "production"
      ? [{ id: "dev.kitchen", label: "Open the style guide", group: "Developer", icon: <SwatchBook size={16} strokeWidth={1.75} />, keywords: ["kitchen", "components", "arc"], run: () => router.push(paths.kitchen) }]
      : []),
    { id: "account.signout", label: "Sign out", description: "Sign this browser out of Silicon Accounts", group: "Account", icon: <LogOut size={16} strokeWidth={1.75} />, keywords: ["logout", "log out", "sign out"], run: () => void doSignOut() },
  ], [go, doSignOut, router]);

  // ⌘K toggles the palette; 1 to 7 jump to sections (never while typing or with a layer open).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        toggleCommandPalette();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat || paletteOpen || isTypingTarget(event.target)) return;
      if (document.querySelector("[role='dialog'][aria-modal='true'], [role='menu']")) return;
      const section = SECTIONS.find(entry => entry.shortcut === event.key);
      if (!section || status !== "signed_in") return;
      event.preventDefault();
      go(section.href);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [go, paletteOpen, status]);

  const account = useMemo<DockAccount | null>(() => {
    const summary = session?.account;
    if (!summary) return null;
    const full = me.data;
    return {
      name: full?.display_name ?? summary.display_name,
      email: full?.id ?? summary.id ?? summary.uuid,
      avatarSrc: full?.pfp_url ?? summary.pfp_url,
      kind: summary.kind,
    };
  }, [session, me.data]);

  const chrome = (content: ReactNode) => (
    <div className={styles.shell}>
      <a className="skip-link" href="#main">Skip to content</a>
      <header className={styles.top}>
        <Link href={paths.home} className={styles.brand} onClick={event => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey) return;
          event.preventDefault();
          go(paths.home);
        }}>
          <BrandMark />
          <span className={styles.brandText}>Silicon <span className={styles.brandMuted}>Accounts</span></span>
        </Link>
        <button data-sq="surface" type="button" className={styles.search} onClick={openCommandPalette} aria-keyshortcuts={isApple ? "Meta+K" : "Control+K"}>
          <Search size={16} strokeWidth={1.75} aria-hidden="true" />
          <span>Search and jump</span>
          <kbd data-sq="surface">{isApple ? "⌘ K" : "Ctrl K"}</kbd>
        </button>
      </header>
      <main id="main" className={styles.main} tabIndex={-1}>{content}</main>
      <Dock
        activeKey={active?.key}
        onNavigate={go}
        account={account}
        onSignOut={doSignOut}
        onOpenSettings={() => go(paths.settings)}
        onOpenPalette={openCommandPalette}
        isApple={isApple}
      />
      <CommandMenu />
    </div>
  );

  if (returning) return chrome(<PageSkeleton />);
  if (status === "signed_in") {
    return chrome(
      <ViewTransition key={active?.key ?? pathname} enter={PAGE_CLASSES} exit={PAGE_CLASSES} default="none">
        <div className={styles.page}>{children}</div>
      </ViewTransition>,
    );
  }
  if (status === "signed_out" && isHome) return <div className={styles.bare}>{children}</div>;
  if (status === "error") {
    return (
      <div className={styles.problem}>
        <Alert tone="danger" title="Silicon Accounts is not answering">
          {error?.message ?? "The session could not be loaded."} {error?.hint ?? "Check your connection, then try again."}
          <span style={{ display: "block", marginTop: "var(--space-3)" }}>
            <Button variant="secondary" size="sm" onClick={refetch}>Try again</Button>
          </span>
        </Alert>
      </div>
    );
  }
  // Loading, or signed out on an account page (on the way to sign in).
  return isHome ? <div className={styles.bare} aria-busy="true" /> : chrome(<PageSkeleton />);
}
