/** Matches the API's trimmed Unicode-character limit; string.length counts UTF-16 units. */
export const MAX_VERIFICATION_REASON = 5000;

export function verificationReasonProblem(reason: string): string | undefined {
  const length = [...reason.trim()].length;
  if (!length) return "Tell us why you’re requesting account verification.";
  if (length > MAX_VERIFICATION_REASON) return "Keep the reason to 5,000 characters or fewer.";
  if (reason.includes("\0")) return "The reason must not contain a NUL character.";
  return undefined;
}
