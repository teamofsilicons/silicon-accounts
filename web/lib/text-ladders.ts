/**
 * The text grey ladders /__text compares (Anil, 2026-11-10): four greys each, darkest first (text, the new step,
 * secondary, muted), with their CIELAB lightness. Candidate colours, so raw values, like lib/text-edits.ts.
 */
export interface Ladder { id: string; name: string; note: string; greys: [string, string, string, string]; lightness: [number, number, number, number] }

export const NOW: Ladder = { id: "now", name: "Before · OpenAI's", note: "Before 2026-11-10: no step, the lines under a name used the secondary grey. 4 → 40 is the jump.", greys: ["#0D0D0D", "#5D5D5D", "#5D5D5D", "#8F8F8F"], lightness: [4, 40, 40, 59] };

export const LADDERS: Ladder[] = [
  { id: "insert", name: "A · Insert a step", note: "Keep ours and add one grey halfway, at 24, for the lines under a name.", greys: ["#0D0D0D", "#393939", "#5D5D5D", "#8F8F8F"], lightness: [4, 24, 40, 59] },
  { id: "soften", name: "B · Softer secondary", note: "Keep the text; the step at 20 and the secondary darker, at 32: three even-ish steps (16, 12) before muted.", greys: ["#0D0D0D", "#303030", "#4B4B4B", "#8E8E8E"], lightness: [4, 20, 32, 59] },
  { id: "even", name: "C · Even thirds (Home now)", note: "Chosen 2026-11-10. Text a little lighter (10), then 22 and 34: twelve apart each, like Refactoring UI but a shade darker.", greys: ["#1B1B1B", "#353535", "#505050", "#8E8E8E"], lightness: [10, 22, 34, 59] },
  { id: "rui-neutral", name: "D · Refactoring UI, neutral", note: "Refactoring UI's lightness (15, 24, 34, 59) in our pure greys.", greys: ["#262626", "#393939", "#505050", "#8E8E8E"], lightness: [15, 24, 34, 59] },
  { id: "rui", name: "E · Refactoring UI, as is", note: "The book's greys with their touch of blue: #22252A, #353A3F, #4A5056, #878E95.", greys: ["#22252A", "#353A3F", "#4A5056", "#878E95"], lightness: [15, 24, 34, 59] },
];
