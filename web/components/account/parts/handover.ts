/**
 * Handing a Silicon to another Carbon: what was typed (a c:id or an email) turned into the `to` the API takes, or why it
 * can't be. Shared by the Silicon's page (Settings › Looked after by) and Delete your account (/privacy/delete).
 */
import type { CarbonMe } from "@/lib/api/types";

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Turns what was typed into the `to` the API takes (`c:id` or an email), or says why it can't be. */
export function recipient(raw: string, me: CarbonMe): { to: string } | { problem: string } {
  const value = raw.trim().toLowerCase();
  if (!value) return { problem: "Name the Carbon who should take over: their c:id or their email." };
  if (value.startsWith("si:")) return { problem: "A Silicon can\u2019t look after a Silicon. Name a Carbon\u2019s c:id or email." };
  if (value.includes("@")) {
    if (!EMAIL_SHAPE.test(value)) return { problem: `Enter an email like name@example.com; \u201c${value}\u201d isn\u2019t one.` };
    if (me.emails.some(item => item.email.toLowerCase() === value)) return { problem: `${value} is your own email, and you already look after it.` };
    return { to: value };
  }
  const handle = value.replace(/^c:/, "");
  if (!/^[a-z0-9_-]{3,30}$/.test(handle)) return { problem: "A CarbonID is c: and 3 to 30 of a to z, 0 to 9, - and _." };
  const to = `c:${handle}`;
  if (me.id && to === me.id.toLowerCase()) return { problem: "That\u2019s your own CarbonID, and you already look after it." };
  return { to };
}

