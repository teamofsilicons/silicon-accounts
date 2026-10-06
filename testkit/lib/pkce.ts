// PKCE (RFC 7636) and the other random values a sign-in request needs.

import { createHash, randomBytes } from 'node:crypto';

export type PkceMethod = 'S256' | 'plain';

export interface PkcePair {
  code_verifier: string;
  code_challenge: string;
  code_challenge_method: PkceMethod;
}

/** 32 random bytes → a 43-character base64url verifier (the RFC 7636 recommendation). */
export function generateCodeVerifier(bytes = 32): string {
  if (bytes < 32 || bytes > 96) throw new RangeError('PKCE verifiers need 32..96 random bytes (43..128 characters).');
  return randomBytes(bytes).toString('base64url');
}

/** BASE64URL(SHA256(ASCII(code_verifier))). */
export function codeChallengeS256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export function createPkcePair(method: PkceMethod = 'S256'): PkcePair {
  const code_verifier = generateCodeVerifier();
  return { code_verifier, code_challenge: method === 'S256' ? codeChallengeS256(code_verifier) : code_verifier, code_challenge_method: method };
}

/** True when `verifier` matches `challenge` under `method`. */
export function pkceMatches(verifier: string, challenge: string, method: PkceMethod = 'S256'): boolean {
  return (method === 'S256' ? codeChallengeS256(verifier) : verifier) === challenge;
}

export function randomState(): string {
  return randomBytes(24).toString('base64url');
}

export function randomNonce(): string {
  return randomBytes(24).toString('base64url');
}
