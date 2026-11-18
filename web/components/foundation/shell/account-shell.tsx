"use client";

/**
 * The account site's frame for signed-in pages: from 900px the sidebar (sidebar.tsx) beside the page, the window's full
 * height, with the brand (home) and search (the ⌘K palette) at its head and the account menu at its foot; below that a
 * top bar with the brand and a menu button that opens the same sidebar in a bottom sheet (Anil, 2026-11-17). Also the ⌘K palette, number-key
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
import { ViewTransition, useCallback, useEffect, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { Database, LogOut, Menu, Search, SwatchBook, UserRound, UserRoundPlus } from "lucide-react";
import { Alert } from "@teamofsilicons/silicon-ui/alert";
import { BottomSheet } from "@teamofsilicons/silicon-ui/bottom-sheet";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { SkeletonBlock } from "@/components/foundation/feedback/skeleton-block";
import { Page, SkipLink } from "@/components/foundation/layout/layout";
import { openCommandPalette, toggleCommandPalette, useCommandPaletteOpen, useRegisterCommands } from "@/lib/commands";
import { ELSEWHERE, MORE_DESTINATIONS, SECTIONS, navigationType, paths, sectionFor } from "@/lib/navigation";
import { GUARDED_NAVIGATION, confirmNavigation, navigationIsGuarded, useGuardedLinks } from "@/lib/navigation-guard";
import { notifyError } from "@/lib/notify";
import { browserProfileChanged, useBrowserAccounts, useSwitchBrowserAccount } from "@/lib/query/linked-accounts";
import { beginSignIn, firstPartySignInUrl, useDeveloperUrl, useMe, useSession, useSignOut } from "@/lib/query/session";
import { PrototypeMark } from "./brand-mark";
import { CommandMenu } from "./command-menu";
import { LeaveQuestionHost } from "./leave-question";
import { ProfileList, ProfileMenu } from "./profile-menu";
import { Sidebar } from "./sidebar";
import { SIDEBAR_STEPS, SidebarResize, useSidebarStep } from "./sidebar-resize";
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

/** A page's title while it loads: a sidebar section or a page reached from one, by its exact path; else unknown. */
function loadingTitle(pathname: string): { title?: string; nested: boolean } {
  const exact = [...SECTIONS, ...MORE_DESTINATIONS].find(item => item.href === pathname);
  if (exact) return { title: exact.label, nested: !SECTIONS.some(section => section.href === pathname) };
  return { nested: true };
}

/**
 * The loading stand-in for an account page, drawn like the page it becomes (Anil, 2026-11-12): the page bar pinned at the
 * top with the title when the path names it (a crumb's line above it on nested pages), then sections on the page column,
 * each a heading over a boxed list, so nothing jumps when the page arrives.
 */
export function PageSkeleton({ pathname = "" }: { pathname?: string }) {
  const { title, nested } = loadingTitle(pathname);
  return (
    <div aria-busy="true" aria-label={title ? `Loading ${title}` : "Loading"}>
      <div className={styles.loadingBar}>
        {nested ? <div className={styles.loadingCrumb}><SkeletonBlock width="6rem" height="1rem" radius="var(--radius-control)" /></div> : null}
        <div className={styles.loadingTitleRow}>
          {title ? <h1 className={styles.loadingTitle}>{title}</h1> : <SkeletonBlock width="min(14rem, 60%)" height="1.75rem" radius="var(--radius-control)" />}
        </div>
      </div>
      <Page>
        {[2, 3, 2].map((rows, index) => (
          <div key={index} className={styles.loadingSection}>
            <SkeletonBlock width="8rem" height="1.25rem" radius="var(--radius-control)" index={index} />
            <SkeletonBlock width="100%" height={`calc(${rows} * 3rem)`} radius="var(--radius-container)" index={index} />
          </div>
        ))}
      </Page>
    </div>
  );
}

const PAGE_CLASSES = { "nav-forward": "page-forward", "nav-back": "page-back", "nav-fade": "page-fade", default: "page-fade" };

export function AccountShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { status, session, error, refetch } = useSession();
  const me = useMe();
  const { signOut, pending: signingOut } = useSignOut();
  const paletteOpen = useCommandPaletteOpen();
  const isApple = useSyncExternalStore(subscribeNothing, detectApple, () => false);
  const isHome = pathname === "/";
  const active = sectionFor(pathname);
  const developerUrl = useDeveloperUrl();
  const narrow = useSyncExternalStore(subscribeNarrow, readNarrow, () => false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sidebarStep, setSidebarStep] = useSidebarStep();

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

  // From 900px the page box is the scroller, not the window (shell.module.css), so a new page starts at its top.
  useEffect(() => {
    document.getElementById("main")?.scrollTo({ top: 0 });
  }, [pathname]);

  // Another tab switched this browser to another account (Saket, 2026-11-18): this one follows, to Home.
  useEffect(() => {
    const onSwitch = (event: StorageEvent) => {
      if (event.key === browserProfileChanged && event.newValue !== session?.account.uuid) window.location.replace(paths.home);
    };
    window.addEventListener("storage", onSwitch);
    return () => window.removeEventListener("storage", onSwitch);
  }, [session?.account.uuid]);

  // The accounts signed in on this browser, for the palette's switch commands (the switcher reads the same query).
  const browserAccounts = useBrowserAccounts(status === "signed_in");
  const switchAccount = useSwitchBrowserAccount();
  const switchTo = useCallback(async (uuid: string) => {
    if (!(await confirmNavigation(paths.home))) return;
    try {
      await switchAccount.mutateAsync({ account_uuid: uuid });
      window.location.assign(paths.home);
    } catch (failure) {
      notifyError(failure);
    }
  }, [switchAccount]);
  const otherAccounts = (browserAccounts.data?.accounts ?? []).filter(other => other.uuid !== session?.account.uuid);

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
        icon: <Icon size={16} strokeWidth={2} />,
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
        icon: <Icon size={16} strokeWidth={2} />,
        keywords: [destination.key, "go", "open"],
        run: () => void go(destination.href),
      };
    }),
    // The old Settings page is Data & privacy now (a section above); these words still find it.
    { id: "go.delete-account", label: "Delete account", description: "On Data & privacy", group: "Go to", icon: <Database size={16} strokeWidth={2} />, keywords: ["settings", "preferences", "delete", "close account"], run: () => void go(paths.privacy) },
    ...ELSEWHERE.map(site => {
      const Icon = site.icon;
      return {
        id: `elsewhere.${site.key}`,
        label: site.label,
        description: site.description,
        group: "Other sites",
        icon: <Icon size={16} strokeWidth={2} />,
        keywords: site.key === "developer" ? ["developer", "build", "apps", "sign-in setup", "client"] : ["docs", "documentation", "help", "guide", "api"],
        run: () => void go(site.href(developerUrl)),
      };
    }),
    ...(process.env.NODE_ENV !== "production"
      ? [
          { id: "dev.kitchen", label: "Open the style guide", group: "Developer", icon: <SwatchBook size={16} strokeWidth={2} />, keywords: ["kitchen", "components", "arc"], run: () => void go(paths.kitchen) },
        ]
      : []),
    ...otherAccounts.map(other => ({
      id: `account.switch.${other.uuid}`,
      label: `Switch to ${other.display_name}`,
      description: other.org ? `${other.id ?? other.uuid} · ${other.org.name}` : (other.id ?? other.uuid),
      group: "Account",
      icon: <UserRound size={16} strokeWidth={2} />,
      keywords: ["switch", "account", "profile", other.id ?? "", other.display_name],
      run: () => void switchTo(other.uuid),
    })),
    {
      id: "account.add",
      label: "Add another account",
      description: "Sign in to another account in this browser",
      group: "Account",
      icon: <UserRoundPlus size={16} strokeWidth={2} />,
      keywords: ["add", "account", "sign in", "another", "profile"],
      run: () => void confirmNavigation(paths.signIn).then(ok => { if (ok) window.location.assign(firstPartySignInUrl(paths.home, { prompt: "login" })); }),
    },
    { id: "account.signout", label: "Sign out", description: "Sign this browser out of Silicon Accounts", group: "Account", icon: <LogOut size={16} strokeWidth={2} />, keywords: ["logout", "log out", "sign out"], run: () => void doSignOut() },
  ], [go, doSignOut, developerUrl, otherAccounts.map(other => other.uuid).join(), switchTo]);

  // ⌘K toggles the palette; 1 to 7 jump to sections (never while typing or with a layer open).
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

  // The signed-in account: its full record once loaded (the switcher's photo, name and id).
  const account = session ? me.data ?? session.account : null;

  const brand = (
    <Link href={paths.home} aria-label="Team of Silicons Accounts" data-sq="surface" className={styles.brand} {...{ [GUARDED_NAVIGATION]: "" }} onClick={event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey) return;
      event.preventDefault();
      void go(paths.home, event.currentTarget);
    }}>
      <PrototypeMark />
      <span className={styles.brandText}>Team of Silicons <b className={styles.brandProduct}>Accounts</b></span>
    </Link>
  );
  const search = (
    // Keyed by the layout: Silicon UI's Button measures its label once and keeps that width inline, so a new Button
    // measures again when the sidebar moves between the page's side and the phone sheet.
    <Button
      key={narrow ? "narrow" : "wide"}
      variant="soft"
      size="sm"
      className={styles.search}
      onClick={() => {
        setSheetOpen(false);
        openCommandPalette();
      }}
      aria-keyshortcuts={isApple ? "Meta+K" : "Control+K"}
    >
      <Search size={16} strokeWidth={2.1} aria-hidden="true" />
      <span className={styles.searchLabel}>Search</span>
      <kbd data-sq="surface" className={styles.keys}>{isApple ? "⌘K" : "Ctrl K"}</kbd>
    </Button>
  );
  // The account switcher at the sidebar's foot (profile-menu.tsx): beside the page a full-width row opening a menu; in
  // the phone sheet its rows are listed in place.
  const accountMenu = account ? (
    <ProfileMenu account={account} onManage={() => void go(paths.linkedAccounts)} onSignOut={menuSignOut} signingOut={signingOut} />
  ) : null;
  const accountList = account ? (
    <ProfileList account={account} onManage={() => void go(paths.linkedAccounts)} onSignOut={menuSignOut} signingOut={signingOut} onDone={() => setSheetOpen(false)} />
  ) : null;

  // The full-height shell (Anil, 2026-11-17, from the Apps store): from 900px no top bar; the sidebar carries the
  // wordmark and search at its head and the account menu at its foot, and it and the page box run the window's full
  // height in 8px of padding. Under 900px a top bar with the wordmark and the menu button; the sidebar (search, the
  // sections, the account menu, the other sites) opens in a bottom sheet, and the page is full bleed. (The top-bar
  // shell of 2026-10-30 is in git before this change.)
  const chrome = (content: ReactNode) => (
    <div className={styles.shell}>
      <SkipLink href="#main" />
      {/* Drawn on every width, hidden from 900px by CSS, so a phone has it before the page knows its width. */}
      <header className={styles.top}>
        {brand}
        {narrow ? (
          <BottomSheet
            title="Your account"
            open={sheetOpen}
            onOpenChange={setSheetOpen}
            trigger={<Button variant="ghost" size="sm" aria-label="Menu"><Menu size={18} strokeWidth={2} aria-hidden="true" /></Button>}
          >
            <Sidebar activeKey={active?.key} developerUrl={developerUrl} onNavigate={() => setSheetOpen(false)} head={search} account={accountList} />
          </BottomSheet>
        ) : null}
      </header>
      <div className={styles.body} style={{ "--sidebar-width": `${SIDEBAR_STEPS[sidebarStep]}px` } as CSSProperties}>
        {narrow ? null : (
          <>
            <aside id="account-sidebar" className={styles.aside}>
              <Sidebar activeKey={active?.key} developerUrl={developerUrl} head={<><div className={styles.brandRow}>{brand}</div>{search}</>} account={accountMenu} />
            </aside>
            <SidebarResize step={sidebarStep} onStep={setSidebarStep} controls="account-sidebar" />
          </>
        )}
        <main id="main" data-sq-native="" className={styles.main} tabIndex={-1}>{content}</main>
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
            <Button variant="secondary" size="sm" onClick={refetch}>Try Again</Button>
          </span>
        </Alert>
      </div>
    );
  }
  // Loading, or signed out on an account page (on the way to sign in).
  return isHome ? <div className={styles.bare} aria-busy="true" /> : chrome(<PageSkeleton pathname={pathname} />);
}
