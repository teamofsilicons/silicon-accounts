/**
 * Passkeys in the browser (Anil, 2026-11-23): the WebAuthn ceremonies the account site and the hosted sign-in run, with
 * the JSON the API speaks (crates/core/src/webauthn.rs). The API sends the options with binary fields as base64url and
 * expects `PublicKeyCredential.toJSON()` back; browsers that have `parseCreationOptionsFromJSON` / `toJSON` use them,
 * older ones get the same conversion done here.
 *
 * A ceremony the person cancels (or that times out) resolves to `null`: nothing to say, the page stays as it was. Other
 * failures throw a PasskeyError with words to show.
 */
import { useSyncExternalStore } from "react";
import type { PasskeyCreationOptionsJSON, PasskeyRequestOptionsJSON } from "@/lib/api/types";

export class PasskeyError extends Error {}

/** True when this browser can create and use passkeys. */
export function isPasskeySupported(): boolean {
  return typeof window !== "undefined" && typeof window.PublicKeyCredential === "function" && !!navigator.credentials;
}

const never = () => () => {};

/** `isPasskeySupported()` for rendering: false on the server and in the first paint, so they match. */
export function usePasskeySupport(): boolean {
  return useSyncExternalStore(never, isPasskeySupported, () => false);
}

/** True when the browser can offer a saved passkey from a field's autofill (conditional mediation). */
export async function canAutofillPasskeys(): Promise<boolean> {
  if (!isPasskeySupported()) return false;
  const check = (PublicKeyCredential as unknown as { isConditionalMediationAvailable?: () => Promise<boolean> }).isConditionalMediationAvailable;
  try {
    return typeof check === "function" ? await check.call(PublicKeyCredential) : false;
  } catch {
    return false;
  }
}

function fromBase64url(value: string): ArrayBuffer {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function toBase64url(buffer: ArrayBuffer | ArrayBufferView | null | undefined): string | null {
  if (!buffer) return null;
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

type JsonStatic = {
  parseCreationOptionsFromJSON?: (options: unknown) => PublicKeyCredentialCreationOptions;
  parseRequestOptionsFromJSON?: (options: unknown) => PublicKeyCredentialRequestOptions;
};

function creationOptions(json: PasskeyCreationOptionsJSON): PublicKeyCredentialCreationOptions {
  const parse = (PublicKeyCredential as unknown as JsonStatic).parseCreationOptionsFromJSON;
  if (typeof parse === "function") return parse.call(PublicKeyCredential, json);
  return {
    ...(json as unknown as PublicKeyCredentialCreationOptions),
    challenge: fromBase64url(json.challenge),
    user: { ...json.user, id: fromBase64url(json.user.id) },
    excludeCredentials: (json.excludeCredentials ?? []).map(c => ({ type: c.type, id: fromBase64url(c.id), transports: c.transports as AuthenticatorTransport[] | undefined })),
  };
}

function requestOptions(json: PasskeyRequestOptionsJSON): PublicKeyCredentialRequestOptions {
  const parse = (PublicKeyCredential as unknown as JsonStatic).parseRequestOptionsFromJSON;
  if (typeof parse === "function") return parse.call(PublicKeyCredential, json);
  return {
    ...(json as unknown as PublicKeyCredentialRequestOptions),
    challenge: fromBase64url(json.challenge),
    allowCredentials: (json.allowCredentials ?? []).map(c => ({ type: c.type, id: fromBase64url(c.id), transports: c.transports as AuthenticatorTransport[] | undefined })),
  };
}

/** `PublicKeyCredential.toJSON()`, or the same built by hand. */
function credentialJson(credential: PublicKeyCredential): Record<string, unknown> {
  const own = (credential as unknown as { toJSON?: () => Record<string, unknown> }).toJSON;
  if (typeof own === "function") return own.call(credential);
  const isCreate = "attestationObject" in credential.response;
  const created = credential.response as AuthenticatorAttestationResponse;
  const asserted = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: toBase64url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment ?? null,
    clientExtensionResults: credential.getClientExtensionResults?.() ?? {},
    response: isCreate
      ? {
        clientDataJSON: toBase64url(created.clientDataJSON),
        attestationObject: toBase64url(created.attestationObject),
        transports: typeof created.getTransports === "function" ? created.getTransports() : [],
      }
      : {
        clientDataJSON: toBase64url(asserted.clientDataJSON),
        authenticatorData: toBase64url(asserted.authenticatorData),
        signature: toBase64url(asserted.signature),
        userHandle: toBase64url(asserted.userHandle),
      },
  };
}

/** A cancelled or timed-out ceremony: no message, nothing happened. */
function cancelled(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "AbortError");
}

function failure(error: unknown, adding: boolean): PasskeyError {
  if (error instanceof DOMException && error.name === "InvalidStateError") {
    return new PasskeyError(adding ? "This device already has a passkey for your account." : "This passkey can't be used here.");
  }
  if (error instanceof DOMException && error.name === "SecurityError") {
    return new PasskeyError("Passkeys only work on the Team of Silicons sign-in site.");
  }
  return new PasskeyError(adding ? "The passkey couldn't be made. Try again, or use another device." : "The passkey couldn't be used. Try again, or sign in another way.");
}

/** Runs `navigator.credentials.create()`; null when the person cancels. */
export async function createPasskey(options: PasskeyCreationOptionsJSON): Promise<Record<string, unknown> | null> {
  if (!isPasskeySupported()) throw new PasskeyError("This browser can't make passkeys.");
  try {
    const credential = await navigator.credentials.create({ publicKey: creationOptions(options) });
    return credential ? credentialJson(credential as PublicKeyCredential) : null;
  } catch (error) {
    if (cancelled(error)) return null;
    throw failure(error, true);
  }
}

/**
 * Runs `navigator.credentials.get()`; null when the person cancels. `autofill` waits for a passkey picked from a field's
 * autofill (conditional mediation) instead of opening the passkey sheet; `signal` stops that wait.
 */
export async function getPasskey(options: PasskeyRequestOptionsJSON, { autofill = false, signal }: { autofill?: boolean; signal?: AbortSignal } = {}): Promise<Record<string, unknown> | null> {
  if (!isPasskeySupported()) throw new PasskeyError("This browser can't use passkeys.");
  try {
    const credential = await navigator.credentials.get({ publicKey: requestOptions(options), mediation: autofill ? "conditional" : "optional", signal });
    return credential ? credentialJson(credential as PublicKeyCredential) : null;
  } catch (error) {
    if (cancelled(error)) return null;
    throw failure(error, false);
  }
}

/** A name for a new passkey from this browser: "Chrome on macOS", the way Security names a device. */
export function passkeyNameHere(): string {
  if (typeof navigator === "undefined") return "Passkey";
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : null;
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : null;
  if (/Mac OS X/.test(ua) && /Safari\//.test(ua) && !/Chrome\//.test(ua)) return os ? `iCloud Keychain on ${os}` : "iCloud Keychain";
  return [browser, os].filter(Boolean).join(" on ") || "Passkey";
}
