"use client";

/**
 * The account switcher at the sidebar's foot (Anil, 2026-11-18, on Saket's browser profiles of the same day): every
 * account signed in on this browser and their linked work accounts, then the prototype's account menu lines (Add
 * another account, Your accounts, Sign out). Beside the page it is a full-width row (photo, name, chevron, as the
 * account row was) opening a menu upward; in the phone sheet the same rows are listed in place, so a phone never opens
 * a second sheet over the first.
 *
 * Choosing an account switches this browser's session to it (POST /v1/session/accounts/switch) and opens Home; other
 * tabs follow (account-shell.tsx). Sign out ends the current account and its linked work accounts on this browser, and
 * the API resumes the most recently used other account, if any (crates/core/src/http/browser_profiles.rs).
 *
 * Silicon UI's UserMenu lists one account, so the menu is its DropdownMenu with radio rows (a tolerated difference,
 * redesign/prototype-differences.md; UserMenu's `accounts` option is requested upstream).
 */
import { useState } from "react";
import { ChevronsUpDown, LogOut, UserRoundPlus, UsersRound } from "lucide-react";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuRoot, DropdownMenuSeparator, DropdownMenuTrigger } from "@teamofsilicons/silicon-ui/dropdown-menu";
import { NavItem, NavList } from "@teamofsilicons/silicon-ui/nav-list";
import { ProfileAvatar } from "@/components/foundation/avatar/profile-avatar";
import type { AccountSummary } from "@/lib/api/types";
import { paths } from "@/lib/navigation";
import { confirmNavigation } from "@/lib/navigation-guard";
import { notifyError } from "@/lib/notify";
import { useBrowserAccounts, useSwitchBrowserAccount } from "@/lib/query/linked-accounts";
import { firstPartySignInUrl } from "@/lib/query/session";
import styles from "./profile-menu.module.css";

export interface ProfileMenuProps {
  account: AccountSummary;
  /** Opens Your accounts (through the shell's guards). */
  onManage: () => void;
  onSignOut: () => void | Promise<void>;
  signingOut: boolean;
  /** Called after any choice (closes the phone sheet). */
  onDone?: () => void;
}

/** The accounts on this browser, the current one first, and what each choice does. */
function useProfiles({ account, onManage, onSignOut, onDone }: ProfileMenuProps) {
  const accounts = useBrowserAccounts();
  const switchAccount = useSwitchBrowserAccount();
  const profiles = [account, ...(accounts.data?.accounts ?? []).filter(profile => profile.uuid !== account.uuid)];

  async function select(uuid: string) {
    onDone?.();
    if (uuid === account.uuid || !(await confirmNavigation(paths.home))) return;
    try {
      await switchAccount.mutateAsync({ account_uuid: uuid });
      window.location.assign(paths.home);
    } catch (error) {
      notifyError(error);
    }
  }
  const actions = [
    { id: "add", label: "Add another account", Icon: UserRoundPlus, run: () => {
      onDone?.();
      void confirmNavigation(paths.signIn).then(ok => { if (ok) window.location.assign(firstPartySignInUrl(paths.home, { prompt: "login" })); });
    } },
    { id: "manage", label: "Your accounts", Icon: UsersRound, run: () => { onDone?.(); onManage(); } },
    { id: "sign-out", label: "Sign out", Icon: LogOut, run: () => { onDone?.(); void onSignOut(); } },
  ];
  return { profiles, select, actions };
}

function Identity({ profile }: { profile: AccountSummary & { org?: { name: string } | null } }) {
  const handle = profile.id ?? profile.uuid;
  return (
    <span className={styles.identity}>
      <span className={styles.name} title={profile.display_name}>{profile.display_name}</span>
      <span className={`${styles.handle} mono`} title={handle}>{handle}{profile.org ? ` · ${profile.org.name}` : ""}</span>
    </span>
  );
}

/** Beside the page: the sidebar's full-width account row, opening the switcher upward. */
export function ProfileMenu(props: ProfileMenuProps) {
  const { account, signingOut } = props;
  const [open, setOpen] = useState(false);
  const { profiles, select, actions } = useProfiles({ ...props, onDone: () => setOpen(false) });
  return (
    <DropdownMenuRoot open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className={styles.trigger} aria-label={`Accounts, signed in as ${account.display_name}`}>
          <ProfileAvatar profile={account} size="xs" />
          <span className={styles.triggerName}>{account.display_name}</span>
          <ChevronsUpDown size={16} strokeWidth={2} aria-hidden="true" className={styles.chevron} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className={styles.menu} side="top" align="start">
        <DropdownMenuRadioGroup aria-label="Accounts on this browser" value={account.uuid} onValueChange={uuid => void select(uuid)}>
          {profiles.map(profile => (
            <DropdownMenuRadioItem key={profile.uuid} value={profile.uuid} textValue={`${profile.display_name} ${profile.id ?? profile.uuid}`} icon={<ProfileAvatar profile={profile} size="sm" />}>
              <Identity profile={profile} />
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        {actions.map(({ id, label, Icon, run }) => (
          <DropdownMenuItem key={id} icon={<Icon size={16} strokeWidth={2} aria-hidden="true" />} disabled={signingOut} onSelect={event => { event.preventDefault(); run(); }}>
            {id === "sign-out" && signingOut ? "Signing out" : label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenuRoot>
  );
}

/** In the phone sheet: the same accounts and lines, listed in place. */
export function ProfileList(props: ProfileMenuProps) {
  const { account, signingOut } = props;
  const { profiles, select, actions } = useProfiles(props);
  return (
    <div className={styles.list}>
      <NavList label="Accounts on this browser">
        {profiles.map(profile => (
          <NavItem key={profile.uuid} active={profile.uuid === account.uuid} icon={<ProfileAvatar profile={profile} size="sm" />} onSelect={() => void select(profile.uuid)}>
            <Identity profile={profile} />
          </NavItem>
        ))}
      </NavList>
      <NavList label="Account actions">
        {actions.map(({ id, label, Icon, run }) => (
          <NavItem key={id} icon={<Icon size={16} strokeWidth={2} aria-hidden="true" />} disabled={signingOut} onSelect={run}>
            {id === "sign-out" && signingOut ? "Signing out" : label}
          </NavItem>
        ))}
      </NavList>
    </div>
  );
}
