"use client";

import { Avatar, type AvatarProps } from "@teamofsilicons/silicon-ui/avatar";
import type { AccountSummary } from "@/lib/api/types";
import { useCarbonPicture } from "@/lib/carbon-avatar";

/** The profile's picture beside its visible name. */
export function ProfileAvatar({ profile, size = "md" }: { profile: AccountSummary; size?: AvatarProps["size"] }) {
  const picture = useCarbonPicture(profile);
  return <Avatar name={profile.display_name} src={picture?.src ?? undefined} size={size} aria-hidden="true" />;
}
