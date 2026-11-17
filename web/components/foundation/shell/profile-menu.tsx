"use client";

import { useState, useSyncExternalStore } from "react";
import { Check, LogOut, UserRoundPlus, UsersRound } from "lucide-react";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { Drawer, DrawerContent, DrawerTrigger } from "@teamofsilicons/silicon-ui/drawer";
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

const phoneQuery = "(max-width: 639px)";
const subscribePhone = (change: () => void) => {
  const query = window.matchMedia(phoneQuery);
  query.addEventListener("change", change);
  return () => query.removeEventListener("change", change);
};

export function ProfileMenu({ account, onManage, onSignOut, signingOut }: {
  account: AccountSummary;
  onManage: () => void;
  onSignOut: () => void | Promise<void>;
  signingOut: boolean;
}) {
  const [open, setOpen] = useState(false);
  const phone = useSyncExternalStore(subscribePhone, () => window.matchMedia(phoneQuery).matches, () => false);
  const accounts = useBrowserAccounts();
  const switchAccount = useSwitchBrowserAccount();
  const profiles = [account, ...(accounts.data?.accounts ?? []).filter(profile => profile.uuid !== account.uuid)];

  async function selectProfile(uuid: string) {
    setOpen(false);
    if (uuid === account.uuid || !(await confirmNavigation(paths.home))) return;
    try {
      await switchAccount.mutateAsync({ account_uuid: uuid });
      window.location.assign(paths.home);
    } catch (error) {
      notifyError(error);
    }
  }

  const actions = [
    { id: "add", label: "Add another account", Icon: UserRoundPlus, select: () => {
      setOpen(false);
      void confirmNavigation(paths.signIn).then(ok => { if (ok) window.location.assign(firstPartySignInUrl(paths.home, { prompt: "login" })); });
    } },
    { id: "manage", label: "Your accounts", Icon: UsersRound, select: () => { setOpen(false); onManage(); } },
    { id: "sign-out", label: signingOut ? "Signing out" : "Sign out", Icon: LogOut, select: () => {
      const done = onSignOut();
      if (done) void done.finally(() => setOpen(false));
      else setOpen(false);
    } },
  ];

  const trigger = (
    <Button variant="ghost" className={styles.trigger} aria-label={`Account menu for ${account.display_name}`}>
      <ProfileAvatar profile={account} />
    </Button>
  );
  const rows = profiles.map(profile => {
    const handle = profile.id ?? profile.uuid;
    const avatar = <ProfileAvatar profile={profile} />;
    const label = (
      <span className={styles.identity}>
        <span className={styles.name} title={profile.display_name}>{profile.display_name}</span>
        <span className={styles.handle} title={handle}>{handle}</span>
      </span>
    );
    if (phone) {
      const current = profile.uuid === account.uuid;
      return <NavItem key={profile.uuid} active={current} icon={avatar} trailing={current && <Check size={16} aria-hidden="true" />} onSelect={() => void selectProfile(profile.uuid)}>{label}</NavItem>;
    }
    return <DropdownMenuRadioItem key={profile.uuid} value={profile.uuid} textValue={`${profile.display_name} ${handle}`} icon={avatar}>{label}</DropdownMenuRadioItem>;
  });
  const utilities = actions.map(({ id, label, Icon, select }) => {
    const icon = <span className={styles.actionIcon}><Icon size={18} strokeWidth={1.8} aria-hidden="true" /></span>;
    return phone
      ? <NavItem key={id} icon={icon} onSelect={select} disabled={signingOut}>{label}</NavItem>
      : <DropdownMenuItem key={id} icon={icon} disabled={signingOut} onSelect={event => { event.preventDefault(); select(); }}>{label}</DropdownMenuItem>;
  });

  if (phone) return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild>{trigger}</DrawerTrigger>
      <DrawerContent side="bottom" title="Switch accounts">
        <NavList label="Signed-in accounts">{rows}</NavList>
        <div className={styles.sheetActions}><NavList label="Account actions">{utilities}</NavList></div>
      </DrawerContent>
    </Drawer>
  );
  return (
    <DropdownMenuRoot open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent className={styles.menu} align="end">
        <DropdownMenuRadioGroup aria-label="Signed-in accounts" value={account.uuid} onValueChange={uuid => void selectProfile(uuid)}>{rows}</DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        {utilities}
      </DropdownMenuContent>
    </DropdownMenuRoot>
  );
}
