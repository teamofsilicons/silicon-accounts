/**
 * A labelled slider on Kobalte's accessible Slider (arrow keys, Page Up/Down, Home/End), in Arc's control tokens: the
 * track uses --control-track, the fill --control-on, the thumb --control-thumb. The value reads in tabular numerals.
 */
import { Slider } from "@kobalte/core/slider";
import { Show } from "solid-js";
import { cx } from "../../../arc/lib/cx";
import styles from "./parts.module.css";

export interface RangeSliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  /** The shown value, for example "24 px". */
  format?: (value: number) => string;
  description?: string;
  error?: string | null;
  disabled?: boolean;
  class?: string;
}

export function RangeSlider(props: RangeSliderProps) {
  const text = () => (props.format ? props.format(props.value) : String(props.value));
  return (
    <Slider
      class={cx(styles.slider, props.class)}
      value={[props.value]}
      minValue={props.min}
      maxValue={props.max}
      step={props.step ?? 1}
      disabled={props.disabled}
      getValueLabel={params => (props.format ? props.format(params.values[0] ?? props.min) : String(params.values[0] ?? props.min))}
      onChange={values => {
        const next = values[0];
        if (typeof next === "number" && next !== props.value) props.onChange(next);
      }}
    >
      <div class={styles.sliderHead}>
        <Slider.Label class={styles.sliderLabel}>{props.label}</Slider.Label>
        <Slider.ValueLabel class={styles.sliderValue}>{text()}</Slider.ValueLabel>
      </div>
      <Slider.Track class={styles.sliderTrack}>
        <Slider.Fill class={styles.sliderFill} />
        <Slider.Thumb class={styles.sliderThumb}>
          <Slider.Input />
        </Slider.Thumb>
      </Slider.Track>
      <Show when={props.description && !props.error}><Slider.Description class={styles.sliderDescription}>{props.description}</Slider.Description></Show>
      <Show when={props.error}><p class={styles.sliderError} role="alert">{props.error}</p></Show>
    </Slider>
  );
}
