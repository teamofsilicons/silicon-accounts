import { LinkedAccountsPage } from "@/components/account/linked-accounts";
export const metadata = { title: "Your Accounts" };
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ linked?: string }>;
}) {
  const params = await searchParams;
  return <LinkedAccountsPage completedLink={params.linked} />;
}
