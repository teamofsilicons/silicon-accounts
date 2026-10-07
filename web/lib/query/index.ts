/**
 * TanStack Query hooks over the typed API client, by area. Import what a page needs:
 *
 *   import { useMe, useMyApps, useRemoveAppAccess } from "@/lib/query";
 *
 * The provider (QueryClientProvider, toasts, the 401 hook) is in components/foundation/providers.tsx.
 */
export { createQueryClient, type QueryMeta } from "./client";
export { queryKeys } from "./keys";
export { useIdempotencyKey, useIdempotentMutation, useSecretMutation, stableSignature, type IdempotencyKeys, type SecretMutation } from "./idempotency";
export { readEveryPage, useWholeList, MAX_LIST_PAGES, PAGE_LIMIT } from "./pages";
export {
  useMeta, useSession, useMe, setMe, markSignedOut, useSignOut, useRefreshSession, useTelemetryEnabled,
  sameSitePath, safeReturnPath, firstPartySignInUrl, savedSignInReturn, forgetSignInReturn, beginSignIn, FIRST_PARTY_APP_ID,
  type SessionStatus,
} from "./session";
export {
  useUpdateProfile, useUploadPhoto, useRemovePhoto, useChangeId, useIdAvailability, useAccount, useDeleteAccount,
  useEmails, useAddEmail, useVerifyEmail, useMakePrimaryEmail, useRemoveEmail,
  usePhones, useAddPhone, useVerifyPhone, useMakePrimaryPhone, useRemovePhone, useIdentities, useUnlinkIdentity,
  useMyApps, useRemoveAppAccess, useSessions, useRevokeSession, useHistory, useMyProofs, useRevokeMyProof,
  useSetOwnWebhook, useRemoveOwnWebhook, useTestOwnWebhook,
} from "./account";
export {
  useSilicons, useSilicon, useCreateSilicon, useUpdateSilicon, useChangeSiliconId, useUploadSiliconPhoto, useRotateStk,
  useSetSiliconWebhook, useRemoveSiliconWebhook, useTransferSilicon, useCancelTransfer, useDeleteSilicon,
  useCustodianRequests, useAcceptCustodianRequest, useDeclineCustodianRequest,
} from "./silicons";
export {
  useOwnedApps, useApp, useAppPublic, useUpdateSigninConfig, useConfigHistory, useAppUsers, useAppUser, useImports,
  useImport, useImportRows, useStartImport, useWebhookDeliveries, useWebhookDelivery, useSetWebhook, useRemoveWebhook,
  useRotateWebhookSecret, useTestWebhook, useReplayDeliveries, useAppProofs, useCreateAta, useRevokeAppProof,
  type StartImport,
} from "./developer";
export { useCreateFlow, useFlow, useFlowAction, useRefreshFlow, useDeviceRequest, useDecideDevice } from "./auth";
