/**
 * The account site's frame for signed-in pages: top row (brand, search), the page, the floating dock, the ⌘K palette,
 * number-key section shortcuts and page transitions. It also guards the account routes: visitors without a session
 * are sent to sign in and come back to the page they asked for. At "/" a signed-out visitor sees the landing page
 * (rendered bare, without the shell).
 */
import { useLocation, useNavigate, type RouteSectionProps } from "@solidjs/router";
import { LogOut, Moon, Monitor, Search, Settings as SettingsIcon, Sun, SwatchBook } from "lucide-solid";
import { Match, Show, Suspense, Switch, createEffect, createMemo, on, onCleanup, onMount, type JSX } from "solid-js";
import { Alert } from "../../arc/alert/alert";
import { Button } from "../../arc/button/button";
import { SkeletonBlock } from "../../arc/skeleton/skeleton";
import { isApplePlatform, isTypingTarget } from "../../arc/lib/dom";
import { useSquircle } from "../../arc/lib/squircle";
import { changeTheme } from "../../theme/theme-transition";
import { themePreference, type ThemePreference } from "../../theme/theme";
import { allCommands, commandPaletteOpen, openCommandPalette, registerCommands, toggleCommandPalette } from "../commands";
import { SECTIONS, paths, sectionFor, sectionIndex } from "../navigation";
import { notifyError } from "../notify";
import { beginSignIn, finishSignOut, me, refreshSession, sessionError, sessionStatus, signOut, signedInAccount, signingOut } from "../session";
import { CommandMenu } from "./CommandMenu";
import { Dock } from "./Dock";
import { animatePageIn, pageRendered, pageTransitionRunning, transitionTo } from "./page-transition";
import styles from "./shell.module.css";

/** The squircle brand mark (also the favicon). */
export function BrandMark(props: { class?: string }) {
  return (
    <span ref={el => useSquircle(el, { mode: "clip" })} class={props.class ?? styles.brandMark} aria-hidden="true">
      <svg viewBox="0 0 64 64"><circle cx="32" cy="24" r="9" fill="currentColor" /><path fill="currentColor" d="M14 50c2.7-8.4 9.6-13.2 18-13.2S47.3 41.6 50 50c-4.8 3.2-10.9 4.9-18 4.9S18.8 53.2 14 50Z" /></svg>
    </span>
  );
}

export function AccountShell(props: RouteSectionProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const isHome = () => location.pathname === "/";
  const active = createMemo(() => sectionFor(location.pathname));

  /** Navigates inside a page transition whose direction follows the dock. */
  const go = (href: string) => {
    if (href === location.pathname) return;
    const from = sectionIndex(location.pathname);
    const to = sectionIndex(href);
    transitionTo(href, from >= 0 && to >= 0 ? Math.sign(to - from) : 0, () => navigate(href));
  };

  // Account routes need a session; "/" shows the landing page instead. A sign-out this browser asked for goes home.
  createEffect(() => {
    if (sessionStatus() !== "signed_out") return;
    if (signingOut()) {
      if (isHome()) finishSignOut();
      return;
    }
    if (!isHome()) beginSignIn(location.pathname + location.search);
  });

  const onThemeChange = (preference: ThemePreference, trigger: HTMLElement | null) => changeTheme(preference, trigger);
  const doSignOut = async () => {
    try {
      navigate(paths.home, { replace: true });
      await signOut();
    } catch (error) {
      finishSignOut();
      notifyError(error, "Could not sign out");
    }
  };

  // Commands every account page has.
  registerCommands(() => [
    ...SECTIONS.map(section => ({
      id: `go.${section.key}`,
      label: section.label,
      description: section.description,
      group: "Go to",
      shortcut: section.shortcut,
      icon: <section.icon size={16} stroke-width={1.75} />,
      keywords: [section.key, "go", "open"],
      run: () => go(section.href),
    })),
    { id: "go.settings", label: "Settings", description: "Theme, telemetry, sessions and your account", group: "Go to", icon: <SettingsIcon size={16} stroke-width={1.75} />, keywords: ["preferences", "delete", "sessions"], run: () => go(paths.settings) },
    { id: "theme.light", label: "Use the light theme", group: "Appearance", icon: <Sun size={16} stroke-width={1.75} />, keywords: ["theme", "light", "appearance"], run: () => changeTheme("light", null) },
    { id: "theme.dark", label: "Use the dark theme", group: "Appearance", icon: <Moon size={16} stroke-width={1.75} />, keywords: ["theme", "dark", "appearance", "night"], run: () => changeTheme("dark", null) },
    { id: "theme.system", label: "Match the device theme", group: "Appearance", icon: <Monitor size={16} stroke-width={1.75} />, keywords: ["theme", "system", "auto", "appearance"], run: () => changeTheme("system", null) },
    ...(import.meta.env.DEV ? [{ id: "dev.kitchen", label: "Open the style guide", group: "Developer", icon: <SwatchBook size={16} stroke-width={1.75} />, keywords: ["kitchen", "components", "arc"], run: () => navigate(paths.kitchen) }] : []),
    { id: "account.signout", label: "Sign out", description: "Sign this browser out of Silicon Accounts", group: "Account", icon: <LogOut size={16} stroke-width={1.75} />, keywords: ["logout", "log out", "sign out"], run: () => void doSignOut() },
  ]);

  // ⌘K toggles the palette; 1 to 7 jump to sections (never while typing or with a layer open).
  onMount(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        toggleCommandPalette();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat || commandPaletteOpen() || isTypingTarget(event.target)) return;
      if (document.querySelector("[role='dialog'][aria-modal='true'], [role='menu']")) return;
      const section = SECTIONS.find(entry => entry.shortcut === event.key);
      if (!section || sessionStatus() !== "signed_in") return;
      event.preventDefault();
      go(section.href);
    };
    document.addEventListener("keydown", onKey);
    onCleanup(() => document.removeEventListener("keydown", onKey));
  });

  // Tell a pending page transition that the new page is on screen; animate history navigations in.
  let main: HTMLElement | undefined;
  createEffect(on(() => location.pathname, (path, previous) => {
    requestAnimationFrame(() => pageRendered(path));
    if (previous !== undefined && main && !pageTransitionRunning()) {
      const from = sectionIndex(previous);
      const to = sectionIndex(path);
      animatePageIn(main, from >= 0 && to >= 0 ? Math.sign(to - from) : 0);
    }
    if (previous !== undefined && previous !== path) window.scrollTo({ top: 0 });
  }));

  const account = () => {
    const summary = signedInAccount();
    if (!summary) return null;
    const full = me();
    return { displayName: full?.display_name ?? summary.display_name, id: full?.id ?? summary.id ?? summary.uuid, pfpUrl: full?.pfp_url ?? summary.pfp_url, kind: summary.kind };
  };

  const chrome = (content: JSX.Element) => (
    <div class={styles.shell}>
      <a class="skip-link" href="#main">Skip to content</a>
      <header class={styles.top}>
        <a href={paths.home} class={styles.brand} onClick={event => { if (event.button === 0 && !event.metaKey && !event.ctrlKey) { event.preventDefault(); go(paths.identity); } }}>
          <BrandMark />
          <span class={styles.brandText}>Silicon <span class={styles.brandMuted}>Accounts</span></span>
        </a>
        <button ref={el => useSquircle(el)} type="button" class={styles.search} onClick={openCommandPalette} aria-keyshortcuts={isApplePlatform() ? "Meta+K" : "Control+K"}>
          <Search size={16} stroke-width={1.75} aria-hidden="true" />
          <span>Search and jump</span>
          <kbd>{isApplePlatform() ? "⌘ K" : "Ctrl K"}</kbd>
        </button>
      </header>
      <main id="main" ref={main} class={styles.main} tabIndex={-1} data-vt="page">{content}</main>
      <Dock
        activeKey={active()?.key}
        onNavigate={go}
        account={account()}
        themePreference={themePreference()}
        onThemeChange={onThemeChange}
        onSignOut={doSignOut}
        onOpenSettings={() => go(paths.settings)}
        onOpenPalette={openCommandPalette}
      />
      <CommandMenu />
    </div>
  );

  return (
    <Switch>
      <Match when={sessionStatus() === "signed_in"}>
        {chrome(<Suspense fallback={<PageSkeleton />}>{props.children}</Suspense>)}
      </Match>
      <Match when={isHome() && sessionStatus() === "signed_out"}>
        <Suspense fallback={<div class={styles.bare} />}>{props.children}</Suspense>
      </Match>
      <Match when={sessionStatus() === "error"}>
        <div class={styles.problem}>
          <Alert tone="danger" title="Silicon Accounts is not answering" action={<Button variant="secondary" onClick={() => void refreshSession()}>Try again</Button>}>
            {sessionError()?.message ?? "The session could not be loaded."} {sessionError()?.hint ?? "Check your connection, then try again."}
          </Alert>
        </div>
      </Match>
      <Match when={true}>
        <Show when={!isHome()} fallback={<div class={styles.bare} aria-busy="true" />}>{chrome(<PageSkeleton />)}</Show>
      </Match>
    </Switch>
  );
}

/** The loading stand-in for a page: header and two regions in their final positions. */
export function PageSkeleton() {
  return (
    <div class={styles.loading} aria-busy="true" aria-label="Loading">
      <div class={styles.loadingHeader}>
        <SkeletonBlock width="min(320px, 70%)" height="44px" radius="12px" />
        <SkeletonBlock width="min(480px, 90%)" height="18px" radius="8px" index={1} />
      </div>
      <SkeletonBlock width="100%" height="220px" radius="var(--radius-surface)" index={2} />
      <SkeletonBlock width="100%" height="140px" radius="var(--radius-surface)" index={3} />
    </div>
  );
}

/** Commands of the current page plus the shell's, for tests and the palette. */
export { allCommands };
