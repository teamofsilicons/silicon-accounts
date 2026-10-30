/**
 * The layout lab's choices (/__layouts). Each is kept in the page's address, so a combination can be shared and
 * screenshotted. Server-safe: the page reads its search params with `readLayout`.
 */
export const CHOICES = {
  shell: [
    { value: "panel", label: "Panel" },
    { value: "open", label: "Open" },
    { value: "inset", label: "Inset" },
    { value: "flat", label: "Flat" },
  ],
  sidebar: [
    { value: "list", label: "List" },
    { value: "rail", label: "Rail" },
    { value: "grouped", label: "Grouped" },
  ],
  elements: [
    { value: "cards", label: "Cards" },
    { value: "tiles", label: "Tiles" },
    { value: "rows", label: "Rows" },
  ],
  content: [
    { value: "column", label: "Column" },
    { value: "aside", label: "Column + aside" },
    { value: "split", label: "List + detail" },
  ],
} as const;

export type Axis = keyof typeof CHOICES;
export type Layout = { [A in Axis]: (typeof CHOICES)[A][number]["value"] };

export const AXES: Array<{ axis: Axis; label: string }> = [
  { axis: "shell", label: "Shell" },
  { axis: "sidebar", label: "Sidebar" },
  { axis: "elements", label: "Elements" },
  { axis: "content", label: "Content" },
];

/** Each axis from the address, or its first choice when missing or unknown. */
export function readLayout(params: Record<string, string | string[] | undefined>): Layout {
  const pick = <A extends Axis>(axis: A): Layout[A] => {
    const raw = params[axis];
    const value = Array.isArray(raw) ? raw[0] : raw;
    const found = CHOICES[axis].find(choice => choice.value === value);
    return (found ?? CHOICES[axis][0]).value as Layout[A];
  };
  return { shell: pick("shell"), sidebar: pick("sidebar"), elements: pick("elements"), content: pick("content") };
}
