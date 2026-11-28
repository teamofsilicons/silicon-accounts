"use client";

/**
 * The account site's frame for signed-in pages: Silicon UI's AppShell (Anil, 2026-11-28, Silicon UI 0.7.0). From 900px
 * the sidebar beside the page, the window's full height, with the brand (home) and Search (the ⌘K palette) at its head,
 * the sections, and the account switcher and other sites at its foot; below that a top bar with the brand and a menu
 * button that opens the same sidebar in a bottom sheet. Here: the guards, the command registry and number keys, page
 * transitions, and the loading, error and bare states. It also guards the account routes: visitors without a session
 * are sent to sign in and come back to the page they asked for. At "/" a signed-out visitor sees the landing page,
 * rendered bare (without the shell).
 *
 * Every navigation the shell starts (a sidebar link, the brand, the palette, number keys, the account menu, signing
 * out) asks the page's navigation guards first (lib/navigation-guard.ts), and so does a plain click on any other link
 * while a guard protects its destination: a page with unsaved work registers one guard and every way out asks.
 */
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ViewTransition, useCallback, useEffect, type ReactNode } from "react";
import { Database, LogOut, SwatchBook, UserRound, UserRoundPlus, UsersRound } from "lucide-react";
import { Alert } from "@teamofsilicons/silicon-ui/alert";
import { AccountMenu, AccountMenuAvatar, AccountMenuItem, AccountMenuSeparator } from "@teamofsilicons/silicon-ui/account-menu";
import { AppShell, useAppShell, type AppShellPlace, type AppShellProps } from "@teamofsilicons/silicon-ui/app-shell";
import { Button } from "@teamofsilicons/silicon-ui/button";
import type { CommandItem } from "@teamofsilicons/silicon-ui/command-palette";
import { SkeletonBlock } from "@/components/foundation/feedback/skeleton-block";
import { Page } from "@/components/foundation/layout/layout";
import type { AccountSummary } from "@/lib/api/types";
import { pictureSrcOf, useCarbonPicture } from "@/lib/carbon-avatar";
import { setCommandPaletteOpen, useCommandPaletteOpen, useCommands, useRegisterCommands } from "@/lib/commands";
import { ELSEWHERE, MORE_DESTINATIONS, SECTIONS, navigationType, paths, sectionFor } from "@/lib/navigation";
import { confirmNavigation, useGuardedLinks } from "@/lib/navigation-guard";
import { notifyError } from "@/lib/notify";
import { browserProfileChanged, useBrowserAccounts, useSwitchBrowserAccount } from "@/lib/query/linked-accounts";
import { beginSignIn, firstPartySignInUrl, useDeveloperUrl, useMe, useSession, useSignOut } from "@/lib/query/session";
import { PrototypeMark } from "./brand-mark";
import { LeaveQuestionHost } from "./leave-question";
import { SidebarLinks, SidebarNav } from "./sidebar";
import styles from "./shell.module.css";

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

/**
 * The sidebar's account row: Silicon UI's AccountMenu in the Switcher layout (Anil, 2026-11-28, for Accounts and the
 * Apps store). Beside the page a row that opens a native popover the row's width; in the phone sheet the same rows in
 * place, and a choice closes the sheet. Every account signed in on this browser (and their linked work accounts), the
 * current one ticked, then Add another account, Your accounts and Sign out. Choosing an account switches this
 * browser's session to it and opens Home; other tabs follow. Sign out ends the current account and its linked work
 * accounts here, and the API resumes the most recently used other account, if any.
 */
function AccountRow({ account, place, others, onSwitch, onAdd, onManage, onSignOut, signingOut }: {
  account: AccountSummary;
  place: AppShellPlace;
  others: Array<AccountSummary & { org?: { name: string } | null }>;
  onSwitch: (uuid: string) => void;
  onAdd: () => void;
  onManage: () => void;
  onSignOut: () => void;
  signingOut: boolean;
}) {
  const { closeMenu } = useAppShell();
  const picture = useCarbonPicture(account);
  const profiles = [{ ...account, org: null, src: picture?.src ?? undefined }, ...others.map(other => ({ ...other, src: pictureSrcOf(other) ?? undefined }))];
  // In the phone sheet a choice also closes the sheet (beside the page the popover closes itself).
  const then = (run: () => void) => () => {
    closeMenu();
    run();
  };
  return (
    <AccountMenu name={account.display_name} avatarSrc={picture?.src ?? undefined} showIdentity={false} presentation={place === "menu" ? "list" : "menu"} label={`Accounts, signed in as ${account.display_name}`}>
      {profiles.map(profile => {
        const handle = profile.id ?? profile.uuid;
        return (
          <AccountMenuItem
            key={profile.uuid}
            icon={<AccountMenuAvatar name={profile.display_name} src={profile.src} />}
            description={profile.org ? `${handle} · ${profile.org.name}` : handle}
            current={profile.uuid === account.uuid}
            onClick={then(() => { if (profile.uuid !== account.uuid) onSwitch(profile.uuid); })}
          >
            {profile.display_name}
          </AccountMenuItem>
        );
      })}
      <AccountMenuSeparator />
      <AccountMenuItem icon={<UserRoundPlus size={16} strokeWidth={2} aria-hidden="true" />} onClick={then(onAdd)}>Add another account</AccountMenuItem>
      <AccountMenuItem icon={<UsersRound size={16} strokeWidth={2} aria-hidden="true" />} onClick={then(onManage)}>Your accounts</AccountMenuItem>
      <AccountMenuItem icon={<LogOut size={16} strokeWidth={2} aria-hidden="true" />} disabled={signingOut} onClick={then(onSignOut)}>
        {signingOut ? "Signing out" : "Sign out"}
      </AccountMenuItem>
    </AccountMenu>
  );
}

/**
 * AppShell with the command registry's commands and the palette's open state. Its own component, so a page registering
 * commands re-renders only this, not AccountShell (whose commands would register again, and again).
 */
function CommandShell(props: Omit<AppShellProps, "commands" | "onCommand" | "commandsOpen" | "onCommandsOpenChange">) {
  const commands = useCommands();
  const paletteOpen = useCommandPaletteOpen();
  const items: CommandItem[] = commands.map(({ id, label, description, group, keywords, icon, shortcut }) => ({ id, label, description, group, keywords, icon, shortcut }));
  return (
    <AppShell
      {...props}
      commands={items}
      onCommand={item => commands.find(entry => entry.id === item.id)?.run()}
      commandsOpen={paletteOpen}
      onCommandsOpenChange={setCommandPaletteOpen}
    />
  );
}

export function AccountShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { status, session, error, refetch } = useSession();
  const me = useMe();
  const { signOut, pending: signingOut } = useSignOut();
  const paletteOpen = useCommandPaletteOpen();
  const isHome = pathname === "/";
  const active = sectionFor(pathname);
  const developerUrl = useDeveloperUrl();

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

  // From 900px the page box is the scroller, not the window (AppShell), so a new page starts at its top.
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

  // The accounts signed in on this browser, for the switcher and the palette's switch commands.
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
  const addAccount = useCallback(() => {
    void confirmNavigation(paths.signIn).then(ok => { if (ok) window.location.assign(firstPartySignInUrl(paths.home, { prompt: "login" })); });
  }, []);

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
      run: addAccount,
    },
    { id: "account.signout", label: "Sign out", description: "Sign this browser out of Silicon Accounts", group: "Account", icon: <LogOut size={16} strokeWidth={2} />, keywords: ["logout", "log out", "sign out"], run: () => void doSignOut() },
  ], [go, doSignOut, addAccount, developerUrl, otherAccounts.map(other => other.uuid).join(), switchTo]);

  // 1 to 7 jump to sections (never while typing or with a layer open). ⌘K is AppShell's.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
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
    <Link href={paths.home} aria-label="Team of Silicons Accounts" data-sq="surface" className={styles.brand}>
      <PrototypeMark />
      <span className={styles.brandText}>Team of Silicons <b className={styles.brandProduct}>Accounts</b></span>
    </Link>
  );

  // Silicon UI's AppShell (2026-11-28; the full-height shell of 2026-11-17 and the top-bar shell of 2026-10-30 are in
  // git before it). Every link in it is followed through `go`, so the guards ask first.
  const chrome = (content: ReactNode) => (
    <CommandShell
      brand={brand}
      nav={<SidebarNav activeKey={active?.key} />}
      account={place => account ? (
        <AccountRow
          account={account}
          place={place}
          others={otherAccounts}
          onSwitch={uuid => void switchTo(uuid)}
          onAdd={addAccount}
          onManage={() => void go(paths.linkedAccounts)}
          onSignOut={() => void doSignOut()}
          signingOut={signingOut}
        />
      ) : null}
      links={<SidebarLinks developerUrl={developerUrl} />}
      sidebarLabel="Account sidebar"
      onNavigate={({ href, event }) => {
        event.preventDefault();
        const link = event.target instanceof Element ? event.target.closest<HTMLElement>("a[href]") : null;
        void go(href, link);
      }}
      storageKey="sa.sidebar-step"
    >
      {content}
      <LeaveQuestionHost />
    </CommandShell>
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
