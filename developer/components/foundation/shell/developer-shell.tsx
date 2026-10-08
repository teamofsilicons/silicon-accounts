"use client";

/**
 * The developer site's frame for signed-in pages: a calm top bar (the brand, Apps, Docs, search, theme and the account
 * menu), the page, the ⌘K palette and page transitions. It also guards every page: a visitor without a session goes to
 * /sign-in and comes back to the page they asked for.
 *
 * Every navigation the shell starts (the brand, Apps, the palette, signing out) asks the page's navigation guards first
 * (lib/navigation-guard.ts), and so does a plain click on any other link while a guard protects its destination: a
 * page with unsaved work registers one guard and every way out asks.
 */
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ViewTransition, useCallback, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { Settings, Mail, BookOpen, Boxes, CircleUserRound, LogOut, Monitor, Moon, Search, Sun } from "lucide-react";
import { Alert } from "@/components/arc/alert/alert";
import { Button } from "@/components/arc/button/button";
import { ThemeSwitch } from "@/components/arc/theme-switch/theme-switch";
import { UserMenu, type UserMenuUser } from "@/components/arc/user-menu/user-menu";
import { SkeletonBlock } from "@/components/foundation/feedback/skeleton-block";
import { useTheme, type ThemePreference } from "@/components/foundation/theme/use-theme";
import { openCommandPalette, toggleCommandPalette, useCommandPaletteOpen, useRegisterCommands } from "@/lib/commands";
import { navigationType, paths } from "@/lib/navigation";
import { GUARDED_NAVIGATION, confirmNavigation, navigationIsGuarded, useGuardedLinks } from "@/lib/navigation-guard";
import { notifyError } from "@/lib/notify";
import { beginSignIn, useMeta, useSession, useSignOut } from "@/lib/query/session";
import { changeTheme } from "@/lib/theme";
import { PublishingGuard } from "@/components/publishing/guard";
import { BrandMark } from "./brand-mark";
import { CommandMenu } from "./command-menu";
import { LeaveQuestionHost } from "./leave-question";
import styles from "./shell.module.css";

const subscribeNothing = () => () => undefined;

function detectApple(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /mac|iphone|ipad|ipod/i.test(nav.userAgentData?.platform ?? nav.platform ?? "");
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

/** The accounts site (from /v1/meta), where a Carbon manages their own account. */
export function accountsUrlOf(publicUrl: string | undefined): string {
  return publicUrl?.replace(/\/+$/, "") || "https://accounts.teamofsilicons.com";
}

export function DeveloperShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { status, me, error, refetch } = useSession();
  const meta = useMeta();
  const { signOut } = useSignOut();
  const { theme, preference, change } = useTheme();
  const paletteOpen = useCommandPaletteOpen();
  const isApple = useSyncExternalStore(subscribeNothing, detectApple, () => false);
  const accountsUrl = accountsUrlOf(meta.data?.public_url);
  const docsUrl = paths.docs;
  const onApps = pathname === paths.home || pathname.startsWith("/apps/");

  // Every page needs a session.
  useEffect(() => {
    if (status === "signed_out" && pathname !== paths.docs) beginSignIn(window.location.pathname + window.location.search);
  }, [status, pathname]);

  /** Navigates inside a page transition (no guard asked: the caller did). */
  const push = useCallback((href: string) => {
    router.push(href, { transitionTypes: [navigationType(window.location.pathname, href)] });
  }, [router]);

  /** Every navigation the shell starts: the page's guards are asked first, then it moves inside a page transition. */
  const go = useCallback(async (href: string, returnFocus: HTMLElement | null = null) => {
    if (href === pathname) return;
    if (!(await confirmNavigation(href, { returnFocus }))) return;
    push(href);
  }, [pathname, push]);

  // Links in the pages ask too while a guard protects where they go.
  useGuardedLinks(push);

  const doSignOut = useCallback(async () => {
    if (!(await confirmNavigation(paths.home, { reason: "sign-out" }))) return;
    try {
      await signOut();
    } catch (failure) {
      notifyError(failure, "Could not sign out");
    }
  }, [signOut]);

  const menuSignOut = useCallback((): void | Promise<void> => {
    if (navigationIsGuarded(paths.home, "sign-out")) {
      void doSignOut();
      return;
    }
    return doSignOut();
  }, [doSignOut]);

  const openExternal = useCallback((url: string) => void window.open(url, "_blank", "noopener"), []);

  useRegisterCommands(() => [
    { id: "go.apps", label: "Your apps", description: "Every app you own", group: "Go to", icon: <Boxes size={16} strokeWidth={1.75} />, keywords: ["apps", "home"], run: () => void go(paths.home) },
    { id: "go.invitations", label: "Author invitations", group: "Go to", icon: <Mail size={16} />, keywords: ["invite", "author"], run: () => void go(paths.invitations) },
    { id: "go.settings", label: "Developer settings", group: "Go to", icon: <Settings size={16} />, keywords: ["telemetry", "preferences"], run: () => void go(paths.settings) },
    { id: "go.docs", label: "Developer docs", description: "Accounts and Apps guides", group: "Go to", icon: <BookOpen size={16} strokeWidth={1.75} />, keywords: ["docs", "help", "guide"], run: () => void go(docsUrl) },
    { id: "go.account", label: "Your account", description: "Opens accounts.teamofsilicons.com in a new tab", group: "Go to", icon: <CircleUserRound size={16} strokeWidth={1.75} />, keywords: ["account", "profile"], run: () => openExternal(accountsUrl) },
    { id: "theme.light", label: "Use the light theme", group: "Appearance", icon: <Sun size={16} strokeWidth={1.75} />, keywords: ["theme", "light"], run: () => changeTheme("light", null) },
    { id: "theme.dark", label: "Use the dark theme", group: "Appearance", icon: <Moon size={16} strokeWidth={1.75} />, keywords: ["theme", "dark", "night"], run: () => changeTheme("dark", null) },
    { id: "theme.system", label: "Match the device theme", group: "Appearance", icon: <Monitor size={16} strokeWidth={1.75} />, keywords: ["theme", "system", "auto"], run: () => changeTheme("system", null) },
    { id: "account.signout", label: "Sign out", description: "Sign this browser out of the developer site", group: "Account", icon: <LogOut size={16} strokeWidth={1.75} />, keywords: ["logout", "log out", "sign out"], run: () => void doSignOut() },
  ], [go, doSignOut, docsUrl, accountsUrl, openExternal]);

  // ⌘K toggles the palette.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        toggleCommandPalette();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [paletteOpen]);

  const user = useMemo<UserMenuUser | null>(() => (me ? { name: me.display_name, email: me.id ?? me.uuid, avatarSrc: me.pfp_url } : null), [me]);

  const chrome = (content: ReactNode) => (
    <div className={styles.shell}>
      <a className="skip-link" data-sq="surface" href="#main">Skip to content</a>
      <header className={styles.top}>
        <div className={styles.topStart}>
          <Link href={paths.home} data-sq="surface" className={styles.brand} {...{ [GUARDED_NAVIGATION]: "" }} onClick={event => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey) return;
            event.preventDefault();
            void go(paths.home, event.currentTarget);
          }}>
            <BrandMark />
            <span className={styles.brandText}>Silicon <span className={styles.brandMuted}>Developer</span></span>
          </Link>
          <nav className={styles.nav} aria-label="Developer site">
            <Link href={paths.home} data-sq="surface" className={styles.navLink} aria-current={onApps ? "page" : undefined} {...{ [GUARDED_NAVIGATION]: "" }} onClick={event => {
              if (event.button !== 0 || event.metaKey || event.ctrlKey) return;
              event.preventDefault();
              void go(paths.home, event.currentTarget);
            }}>Apps</Link>
            <Link href={paths.invitations} data-sq="surface" className={styles.navLink}>Invitations</Link>
            <Link href={docsUrl} data-sq="surface" className={styles.navLink}>Docs</Link>
          </nav>
        </div>
        <div className={styles.topEnd}>
          <button data-sq="surface" type="button" className={styles.search} onClick={openCommandPalette} aria-keyshortcuts={isApple ? "Meta+K" : "Control+K"}>
            <Search size={16} strokeWidth={1.75} aria-hidden="true" />
            <span className={styles.searchLabel}>Search and jump</span>
            <kbd data-sq="surface">{isApple ? "⌘ K" : "Ctrl K"}</kbd>
          </button>
          <span className={styles.tool}>
            <ThemeSwitch theme={theme} variant="eclipse" iconOnly onThemeChange={(next, _variant, trigger) => change(next, trigger)} />
          </span>
          {user ? (
            <UserMenu
              user={user}
              theme={preference}
              onThemeChange={(next: ThemePreference) => change(next, null)}
              onSignOut={menuSignOut}
              align="end"
              items={[
                { label: "Your account", icon: <CircleUserRound size={16} strokeWidth={1.75} />, onSelect: () => openExternal(accountsUrl) },
                { label: "Author invitations", icon: <Mail size={16} />, onSelect: () => void go(paths.invitations) },
                { label: "Developer settings", icon: <Settings size={16} />, onSelect: () => void go(paths.settings) },
                { label: "Docs", icon: <BookOpen size={16} strokeWidth={1.75} />, onSelect: () => void go(docsUrl) },
                { label: "Search and jump", icon: <Search size={16} strokeWidth={1.75} />, keys: isApple ? ["⌘", "K"] : ["Ctrl", "K"], onSelect: openCommandPalette },
              ]}
            />
          ) : null}
        </div>
      </header>
      <main id="main" className={styles.main} tabIndex={-1}><PublishingGuard />{content}</main>
      <CommandMenu />
      <LeaveQuestionHost />
    </div>
  );

  if (status === "signed_in" || pathname === paths.docs) {
    return chrome(
      <ViewTransition key={pathname.split("/").slice(0, 3).join("/") || "/"} enter={PAGE_CLASSES} exit={PAGE_CLASSES} default="none">
        <div className={styles.page}>{children}</div>
      </ViewTransition>,
    );
  }
  if (status === "error") {
    return (
      <div className={styles.problem}>
        <Alert tone="danger" title="Silicon Accounts is not answering">
          {error?.message ?? "Your sign-in could not be checked."} {error?.hint ?? "Check your connection, then try again."}
          <span style={{ display: "block", marginTop: "var(--space-3)" }}>
            <Button variant="secondary" size="sm" onClick={refetch}>Try again</Button>
          </span>
        </Alert>
      </div>
    );
  }
  // Loading, or signed out (on the way to sign in).
  return chrome(<PageSkeleton />);
}
