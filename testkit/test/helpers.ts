// Shared test utilities.

import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { SignJWT } from 'jose';

export interface AppleKey {
  privateKey: KeyObject;
  privateKeyPem: string;
  publicKeyPem: string;
}

/** A throwaway Apple-style p8 key (EC P-256, PKCS#8 PEM). */
export function generateAppleKey(): AppleKey {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    privateKey,
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

/** Builds the ES256 client_secret JWT Sign in with Apple expects. */
export async function appleClientSecret(input: {
  privateKey: KeyObject;
  teamId: string;
  keyId: string;
  servicesId: string;
  audience: string;
  iat?: number;
  exp?: number;
  alg?: string;
}): Promise<string> {
  const iat = input.iat ?? Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: input.alg ?? 'ES256', kid: input.keyId })
    .setIssuer(input.teamId)
    .setSubject(input.servicesId)
    .setAudience(input.audience)
    .setIssuedAt(iat)
    .setExpirationTime(input.exp ?? iat + 300)
    .sign(input.privateKey);
}

/** GET without following redirects. */
export async function getManual(url: string | URL, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, { redirect: 'manual', headers });
}

export async function postForm(url: string, form: Record<string, string>, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(form).toString() });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

export async function postJson(url: string, json: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers }, body: JSON.stringify(json) });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body, headers: res.headers };
}

export function basic(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

/** Extracts the text content of <pre id="…">…</pre> and parses it as JSON. */
export function preJson(html: string, id: string): unknown {
  const match = new RegExp(`<pre id="${id}">([\\s\\S]*?)</pre>`).exec(html);
  if (!match?.[1]) throw new Error(`no <pre id="${id}"> in page`);
  const text = match[1].replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
  return JSON.parse(text);
}

/** Pulls an attribute value from the first tag matching `selectorRe`. */
export function attr(html: string, tagRe: RegExp, name: string): string | null {
  const tag = tagRe.exec(html)?.[0];
  if (!tag) return null;
  const value = new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
  return value === undefined ? null : value.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>');
}

/** The `Cookie` value for every Set-Cookie on a response (name=value pairs only). */
export function cookieFrom(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');
}
