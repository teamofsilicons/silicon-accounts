"use client";

/**
 * A sample Carbon identity card for the public landing page: the real card and faces (faces.tsx) with a fixed
 * account and nothing to edit, so it needs no session or QueryClient. It still tilts toward the pointer and turns over
 * (click it, or Details and Back). The sample is the Carbon the auth mocks use (components/auth/mocks/flows.ts).
 */
import { Avatar } from "@teamofsilicons/silicon-ui/avatar";
import { IdentityCard, type StampProps } from "@/components/foundation/identity/identity-card";
import type { CarbonMe } from "@/lib/api/types";
import { BackFace, FrontFace } from "./faces";
import styles from "./identity.module.css";

const SAMPLE: CarbonMe = {
  uuid: "a8K",
  kind: "carbon",
  id: "c:saket",
  display_name: "Saket Dev",
  pfp_url: "",
  dob: "1998-03-14",
  timezone: "Asia/Kolkata",
  status: "active",
  created_at: "2026-01-12T09:30:00Z",
  updated_at: "2026-01-12T09:30:00Z",
  version: 1,
  emails: [{ email: "saket.dev@example.com", is_primary: true, verified_at: "2026-01-12T09:30:00Z", verified_via: "code" }],
  phones: [{ phone: "+919876543210", is_primary: true, verified_at: "2026-01-12T09:30:00Z" }],
  identities: [],
  custodian_of: 2,
};

const STAMPS: StampProps[] = [
  { name: "Ring", seed: "ring" },
  { name: "Briefcase", seed: "briefcase" },
];

export function IdentityCardSample({ className }: { className?: string }) {
  return (
    <IdentityCard
      className={className}
      label="A sample Carbon identity card"
      front={(
        <FrontFace
          me={SAMPLE}
          stamps={STAMPS}
          photo={<Avatar name={SAMPLE.display_name} size="xl" className={styles.samplePortrait} />}
          name={<p className={styles.sampleName}>{SAMPLE.display_name}</p>}
        />
      )}
      back={<BackFace me={SAMPLE} />}
    />
  );
}
