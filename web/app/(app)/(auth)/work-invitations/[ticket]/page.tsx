import { WorkInvitationPage } from "@/components/auth/work-invitation";
export const metadata = {
  title: "Accept a work account",
  referrer: "strict-origin" as const,
};
export default async function Page({
  params,
}: {
  params: Promise<{ ticket: string }>;
}) {
  const { ticket } = await params;
  return <WorkInvitationPage ticket={ticket} />;
}
