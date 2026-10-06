import { Dynamic } from "solid-js/web";
import { splitProps, type JSX, type ValidComponent } from "solid-js";
import { useSquircle, type SquircleMode } from "./squircle";

export type SquircleProps<T extends ValidComponent = "div"> = {
  /** Element to render. Defaults to a div. */
  as?: T;
  /** "surface" (default) or "clip" for media. */
  mode?: SquircleMode;
  /** Base radius, any CSS length or token, for example "var(--radius-surface)" or "50%". */
  radius?: string;
  /** Background colour (sets --sq-fill). */
  fill?: string;
  /** Border colour (sets --sq-stroke). A 1px border is drawn when set. */
  stroke?: string;
  ref?: (el: HTMLElement) => void;
  class?: string;
  style?: JSX.CSSProperties;
  children?: JSX.Element;
} & Omit<JSX.HTMLAttributes<HTMLElement>, "style" | "ref">;

/**
 * A squircle surface without writing CSS: `<Squircle radius="var(--radius-surface)" fill="var(--surface)"
 * stroke="var(--border)">…</Squircle>`. For state-driven colours, style a class with the --sq-* variables instead.
 */
export function Squircle<T extends ValidComponent = "div">(props: SquircleProps<T>) {
  const [local, rest] = splitProps(props, ["as", "mode", "radius", "fill", "stroke", "ref", "style", "children"]);
  const style = (): JSX.CSSProperties => ({
    ...(local.radius ? { "--sq-r": local.radius } : {}),
    ...(local.fill ? { "--sq-fill": local.fill, background: "var(--sq-fill)" } : {}),
    ...(local.stroke ? { "--sq-stroke": local.stroke, border: "1px solid var(--sq-stroke)" } : {}),
    ...local.style,
  });
  return (
    <Dynamic
      component={(local.as ?? "div") as ValidComponent}
      {...rest}
      style={style()}
      ref={(el: HTMLElement) => {
        useSquircle(el, { mode: local.mode });
        local.ref?.(el);
      }}
    >
      {local.children}
    </Dynamic>
  );
}
