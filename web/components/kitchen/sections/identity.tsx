"use client";

import { useState } from "react";
import { Avatar } from "@/components/silicon-ui/avatar/avatar";
import { AvatarGroup } from "@/components/silicon-ui/avatar-group/avatar-group";
import { Card } from "@/components/silicon-ui/card/card";
import { UserMenu, type UserStatus } from "@/components/silicon-ui/user-menu/user-menu";
import { IdentityCard, IdentityField, LiveClock, StampRow } from "@/components/foundation/identity/identity-card";
import { useTheme } from "@/components/foundation/theme/use-theme";
import { portrait, SAMPLE_APPS } from "../samples";
import { Specimen, Specimens, kitchenStyles as styles } from "../specimen";

export function Identity() {
  const { preference, change } = useTheme();
  const [status, setStatus] = useState<UserStatus>("available");
  return (
    <Specimens>
      <Specimen title="Avatar (squircle, clip) and AvatarGroup">
        <div className={styles.row}>
          <Avatar name="Saket Dev" size="sm" />
          <Avatar name="Saket Dev" src={portrait("Saket Dev", 206)} size="md" />
          <Avatar name="Head of Growth" src={portrait("Head of Growth", 32)} size="lg" status="online" />
          <Avatar name="Atlas" src={portrait("Atlas", 270)} size="xl" />
        </div>
        <AvatarGroup
          label="Silicons in your care"
          members={[
            { name: "Scout", src: portrait("Scout", 160) },
            { name: "Atlas", src: portrait("Atlas", 270) },
            { name: "Courier", src: portrait("Courier", 120) },
            { name: "Head of Growth", src: portrait("Head of Growth", 32), status: "online" },
            { name: "Nova" },
            { name: "Iris" },
          ]}
          max={4}
        />
      </Specimen>
      <Specimen title="Identity card shell: tilt, flip, grain">
        <div className={styles.identityFrame}>
          <IdentityCard
            label="Sample identity card"
            front={
              <div className={styles.cardFace}>
                <div className={styles.cardWho}>
                  <Avatar name="Ada Okafor" src={portrait("Ada Okafor", 340)} size="lg" />
                  <p className={styles.cardName}>Ada Okafor</p>
                </div>
                <div className={styles.cardFields}>
                  <IdentityField label="Id" value="c:ada" mono copyLabel="Copy id" />
                  <IdentityField label="Local time" value="Europe/London"><LiveClock timeZone="Europe/London" /></IdentityField>
                </div>
                <StampRow apps={SAMPLE_APPS.map(app => ({ name: app.name, logoUrl: app.logo, seed: app.app_id }))} max={5} />
              </div>
            }
            back={
              <div className={styles.cardFace}>
                <p className={styles.cardName}>Details</p>
                <IdentityField label="uuid" value="k3Q" mono copyLabel="Copy uuid" />
              </div>
            }
          />
        </div>
      </Specimen>
      <Specimen title="Card with a quick look">
        <Card
          title="Briefcase"
          description="Files for Carbons and Silicons."
          avatar={<Avatar name="Briefcase" src={SAMPLE_APPS[0]?.logo} size="sm" />}
          meta="briefcase"
          status="Signed in 2 hours ago"
          details={<p className={styles.prose}>Briefcase can see your name, id, profile photo, email address and timezone.</p>}
        />
      </Specimen>
      <Specimen title="UserMenu: the account in the dock" single>
        <div className={styles.row}>
          <UserMenu
            user={{ name: "Saket Dev", email: "saketdev12@gmail.com", avatarSrc: portrait("Saket Dev", 206) }}
            status={status}
            onStatusChange={setStatus}
            theme={preference}
            onThemeChange={next => change(next, null)}
            onSignOut={() => new Promise(resolve => setTimeout(resolve, 900))}
            showName
          />
        </div>
      </Specimen>
    </Specimens>
  );
}
