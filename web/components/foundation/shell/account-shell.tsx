"use client";

/**
 * The account site's frame for signed-in pages, as in the lead designer's prototype (redesign/prototype-map.md): a
 * top bar with the brand (home), search (the ⌘K palette) and the account menu, and the section list (sidebar.tsx)
 * beside the page from 900px, in a bottom sheet opened from the top bar below that. Also the ⌘K palette, number-key
 * shortcuts and page transitions. It also guards the account routes: visitors without a
 * session are sent to sign in and come back to the page they asked for. At "/" a signed-out visitor sees the landing
 * page, rendered bare (without the shell).
 *
 * Every navigation the shell starts (brand, palette, number keys, Settings, signing out) asks the
 * page's navigation guards first (lib/navigation-guard.ts), and so does a plain click on any other link while a guard
 * protects its destination: a page with unsaved work registers one guard and every way out asks.
 */
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ViewTransition, useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { LogOut, Menu, Search, Settings as SettingsIcon, SwatchBook } from "lucide-react";
import { Alert } from "@teamofsilicons/silicon-ui/alert";
import { BottomSheet } from "@teamofsilicons/silicon-ui/bottom-sheet";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { UserMenu, type UserMenuUser } from "@teamofsilicons/silicon-ui/user-menu";
import { SkeletonBlock } from "@/components/foundation/feedback/skeleton-block";
import { SkipLink } from "@/components/foundation/layout/layout";
import { openCommandPalette, toggleCommandPalette, useCommandPaletteOpen, useRegisterCommands } from "@/lib/commands";
import { ELSEWHERE, MORE_DESTINATIONS, SECTIONS, navigationType, paths, sectionFor } from "@/lib/navigation";
import { GUARDED_NAVIGATION, confirmNavigation, navigationIsGuarded, useGuardedLinks } from "@/lib/navigation-guard";
import { notifyError } from "@/lib/notify";
import { beginSignIn, useDeveloperUrl, useMe, useSession, useSignOut } from "@/lib/query/session";
import { BrandMark } from "./brand-mark";
import { CommandMenu } from "./command-menu";
import { LeaveQuestionHost } from "./leave-question";
import { Sidebar } from "./sidebar";
import styles from "./shell.module.css";

const subscribeNothing = () => () => undefined;

/** Under 900px the section list moves from beside the page into a bottom sheet. */
const NARROW = "(max-width: 899px)";
const subscribeNarrow = (change: () => void) => {
  const media = window.matchMedia(NARROW);
  media.addEventListener("change", change);
  return () => media.removeEventListener("change", change);
};
const readNarrow = () => window.matchMedia(NARROW).matches;

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
  const { signOut } = useSignOut();
  const paletteOpen = useCommandPaletteOpen();
  const isApple = useSyncExternalStore(subscribeNothing, detectApple, () => false);
  const isHome = pathname === "/";
  const active = sectionFor(pathname);
  const developerUrl = useDeveloperUrl();
  const narrow = useSyncExternalStore(subscribeNarrow, readNarrow, () => false);
  const [sheetOpen, setSheetOpen] = useState(false);

  // Account routes need a session; "/" shows the landing page instead. (Sign-ins come back to /sign-in, which restores
  // the page: this home page never reads a code, state or error from its address.)
  useEffect(() => {
    if (status === "signed_out" && !isHome) beginSignIn(window.location.pathname + window.location.search);
  }, [status, isHome]);

  /** Navigates inside a page transition whose direction follows the sidebar (no guard asked: the caller did). */
  const push = useCallback((href: string) => {
    router.push(href, { transitionTypes: [navigationType(window.location.pathname, href)] });
  }, [router]);

  /**
   * Every navigation the shell starts: the page's guards are asked first (focus goes back to `returnFocus` when the
   * Carbon stays), then it moves inside a page transition.
   */
  const go = useCallback(async (href: string, returnFocus: HTMLElement | null = null) => {
    if (href === pathname) return;
    if (!(await confirmNavigation(href, { returnFocus }))) return;
    // Another site (the developer site): a full navigation.
    if (/^https?:\/\//i.test(href) && new URL(href).origin !== window.location.origin) {
      window.location.assign(href);
      return;
    }
    push(href);
  }, [pathname, push]);

  // Links in the pages ask too while a guard protects where they go.
  useGuardedLinks(push);

  const doSignOut = useCallback(async () => {
    // Nothing in this browser tab survives signing out, so unsaved work is asked about first.
    if (!(await confirmNavigation(paths.home, { reason: "sign-out" }))) return;
    try {
      await signOut();
    } catch (failure) {
      notifyError(failure, "Could not sign out");
    }
  }, [signOut]);

  /**
   * The user menu's "Sign out": with nothing to ask about, the menu shows the sign-out's progress (a promise); when a
   * page will ask about unsaved work first, the menu closes at once and the question takes over.
   */
  const menuSignOut = useCallback((): void | Promise<void> => {
    if (navigationIsGuarded(paths.home, "sign-out")) {
      void doSignOut();
      return;
    }
    return doSignOut();
  }, [doSignOut]);

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
        run: () => void go(section.href),
      };
    }),
    ...MORE_DESTINATIONS.map(destination => {
      const Icon = destination.icon;
      return {
        id: `go.${destination.key}`,
        label: destination.label,
        description: destination.description,
        group: "Go to",
        icon: <Icon size={16} strokeWidth={1.75} />,
        keywords: [destination.key, "go", "open"],
        run: () => void go(destination.href),
      };
    }),
    { id: "go.settings", label: "Settings", description: "Your local time and your account", group: "Go to", icon: <SettingsIcon size={16} strokeWidth={1.75} />, keywords: ["preferences", "delete", "timezone", "time zone"], run: () => void go(paths.settings) },
    ...ELSEWHERE.map(site => {
      const Icon = site.icon;
      return {
        id: `elsewhere.${site.key}`,
        label: site.label,
        description: site.description,
        group: "Other sites",
        icon: <Icon size={16} strokeWidth={1.75} />,
        keywords: site.key === "developer" ? ["developer", "build", "apps", "sign-in setup", "client"] : ["docs", "documentation", "help", "guide", "api"],
        run: () => void go(site.href(developerUrl)),
      };
    }),
    ...(process.env.NODE_ENV !== "production"
      ? [{ id: "dev.kitchen", label: "Open the style guide", group: "Developer", icon: <SwatchBook size={16} strokeWidth={1.75} />, keywords: ["kitchen", "components", "arc"], run: () => void go(paths.kitchen) }]
      : []),
    { id: "account.signout", label: "Sign out", description: "Sign this browser out of Silicon Accounts", group: "Account", icon: <LogOut size={16} strokeWidth={1.75} />, keywords: ["logout", "log out", "sign out"], run: () => void doSignOut() },
  ], [go, doSignOut, developerUrl]);

  // ⌘K toggles the palette; 1 to 6 jump to sections (never while typing or with a layer open).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        toggleCommandPalette();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat || paletteOpen || isTypingTarget(event.target)) return;
      // Any open layer (Radix dialogs, drawers and sheets carry no aria-modal), menu or popup list keeps the keys.
      const layers = document.querySelectorAll("[role='dialog'], [role='alertdialog'], [role='menu'], [role='listbox']");
      if ([...layers].some(layer => layer.getClientRects().length > 0)) return;
      const section = SECTIONS.find(entry => entry.shortcut === event.key);
      if (!section || status !== "signed_in") return;
      event.preventDefault();
      const from = event.target instanceof HTMLElement && event.target !== document.body ? event.target : null;
      void go(section.href, from);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [go, paletteOpen, status]);

  const account = useMemo<UserMenuUser | null>(() => {
    const summary = session?.account;
    if (!summary) return null;
    const full = me.data;
    return {
      name: full?.display_name ?? summary.display_name,
      email: full?.id ?? summary.id ?? summary.uuid,
      avatarSrc: full?.pfp_url ?? summary.pfp_url,
    };
  }, [session, me.data]);

  const chrome = (content: ReactNode) => (
    <div className={styles.shell}>
      <SkipLink href="#main" />
      <header className={styles.top}>
        <Link href={paths.home} data-sq="surface" className={styles.brand} {...{ [GUARDED_NAVIGATION]: "" }} onClick={event => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey) return;
          event.preventDefault();
          void go(paths.home, event.currentTarget);
        }}>
          <BrandMark />
          <span className={styles.brandText}>Silicon Accounts</span>
        </Link>
        <Button variant="secondary" size="sm" className={styles.search} onClick={openCommandPalette} aria-keyshortcuts={isApple ? "Meta+K" : "Control+K"} aria-label={narrow ? "Search your account" : undefined}>
          <Search size={16} strokeWidth={1.75} aria-hidden="true" />
          <span className={styles.searchLabel}>Search your account</span>
          <kbd className={styles.keys}>{isApple ? "⌘ K" : "Ctrl K"}</kbd>
        </Button>
        <span className={styles.topEnd}>
          {account ? (
            <UserMenu
              user={account}
              showTheme={false}
              onSignOut={menuSignOut}
              align="end"
              items={[{ label: "Settings", icon: <SettingsIcon size={16} strokeWidth={1.75} />, onSelect: () => void go(paths.settings) }]}
            />
          ) : null}
          {narrow ? (
            <BottomSheet
              title="Your account"
              open={sheetOpen}
              onOpenChange={setSheetOpen}
              trigger={<Button variant="ghost" size="sm" aria-label="Account sections"><Menu size={18} strokeWidth={1.75} aria-hidden="true" /></Button>}
            >
              <Sidebar activeKey={active?.key} developerUrl={developerUrl} onNavigate={() => setSheetOpen(false)} />
            </BottomSheet>
          ) : null}
        </span>
      </header>
      <div className={styles.body}>
        {narrow ? null : (
          <aside className={styles.aside}>
            <Sidebar activeKey={active?.key} developerUrl={developerUrl} />
          </aside>
        )}
        <main id="main" className={styles.main} tabIndex={-1}>{content}</main>
      </div>
      <CommandMenu />
      <LeaveQuestionHost />
    </div>
  );

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
