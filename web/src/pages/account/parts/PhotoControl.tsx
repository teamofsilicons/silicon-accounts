/**
 * The profile photo on the identity card: drop an image on it, or open the photo menu to choose one or go back to the
 * default photo. The new photo shows at once while it uploads (POST /v1/me/photo, raw bytes, at most 2 MB); a failure
 * puts the old one back and says why.
 */
import { Show, createSignal, onCleanup } from "solid-js";
import { Camera, ImageUp, LoaderCircle } from "lucide-solid";
import { api, type Me } from "../../../api";
import { Avatar } from "../../../arc/avatar/avatar";
import { Button } from "../../../arc/button/button";
import { ConfirmMorph } from "../../../arc/confirm-morph/confirm-morph";
import { Popover, PopoverContent, PopoverDescription, PopoverTitle, PopoverTrigger } from "../../../arc/popover/popover";
import { useSquircle } from "../../../arc/lib/squircle";
import { isDefaultPhoto, PHOTO_ACCEPT, photoProblem, reportFailure } from "./common";
import styles from "./photo.module.css";

function isMe(value: unknown): value is Me {
  return !!value && typeof value === "object" && typeof (value as Me).uuid === "string" && typeof (value as Me).kind === "string" && "version" in (value as object);
}

export function PhotoControl(props: { account: Me; onChange: (next: Me) => void }) {
  const [preview, setPreview] = createSignal<string | null>(null);
  const [uploading, setUploading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [open, setOpen] = createSignal(false);
  const [dragging, setDragging] = createSignal(false);
  let fileInput: HTMLInputElement | undefined;
  let depth = 0;
  onCleanup(() => {
    const url = preview();
    if (url) URL.revokeObjectURL(url);
  });

  const upload = async (file: File) => {
    const problem = photoProblem(file);
    if (problem) {
      setError(problem);
      setOpen(true);
      return;
    }
    setError(null);
    const url = URL.createObjectURL(file);
    setPreview(url);
    setUploading(true);
    try {
      const result = await api.me.uploadPhoto(file);
      props.onChange(isMe(result.me) ? result.me : { ...props.account, pfp_url: result.pfp_url });
      setOpen(false);
    } catch (raw) {
      setError(reportFailure(raw, "Your photo did not change"));
      setOpen(true);
    } finally {
      setUploading(false);
      setPreview(null);
      URL.revokeObjectURL(url);
    }
  };

  const remove = async () => {
    setError(null);
    try {
      props.onChange(await api.me.removePhoto());
    } catch (raw) {
      setError(reportFailure(raw, "Your photo was not removed"));
      throw raw;
    }
  };

  const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
  const onDragEnter = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth += 1;
    setDragging(true);
  };
  const onDragLeave = () => {
    depth = Math.max(0, depth - 1);
    if (!depth) setDragging(false);
  };
  const onDrop = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth = 0;
    setDragging(false);
    const file = event.dataTransfer?.files?.[0];
    if (file) void upload(file);
  };
  const choose = () => fileInput?.click();
  const name = () => props.account.display_name;

  return (
    <div
      class={styles.photo}
      data-dragging={dragging() || undefined}
      data-busy={uploading() || undefined}
      onDragEnter={onDragEnter}
      onDragOver={event => { if (hasFiles(event)) event.preventDefault(); }}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <Avatar name={name()} src={preview() ?? props.account.pfp_url} size="xxl" kind={props.account.kind} />
      <span ref={el => useSquircle(el)} class={styles.dropHint} aria-hidden="true"><ImageUp size={24} stroke-width={1.75} /></span>
      <Show when={uploading()}>
        <span class={styles.busy} aria-hidden="true"><LoaderCircle class={styles.spinner} size={22} stroke-width={1.75} /></span>
      </Show>
      <span class="sr-only" role="status">{uploading() ? "Uploading your photo" : ""}</span>
      <Popover open={open()} onOpenChange={next => { setOpen(next); if (!next) setError(null); }} placement="bottom-start" gutter={8}>
        <PopoverTrigger ref={(el: HTMLElement) => useSquircle(el)} class={styles.trigger} aria-label="Change your photo" disabled={uploading()}>
          <Camera size={16} stroke-width={1.75} aria-hidden="true" />
        </PopoverTrigger>
        <PopoverContent class={styles.menu}>
          <PopoverTitle class={styles.menuTitle}>Profile photo</PopoverTitle>
          <PopoverDescription class={styles.menuText}>PNG, JPEG, WebP or GIF, up to 2 MB. Every app that can see your profile sees it.</PopoverDescription>
          <button
            ref={el => useSquircle(el)}
            type="button"
            class={styles.drop}
            data-dragging={dragging() || undefined}
            onClick={choose}
            onDragEnter={onDragEnter}
            onDragOver={event => { if (hasFiles(event)) event.preventDefault(); }}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
          >
            <ImageUp size={20} stroke-width={1.75} aria-hidden="true" />
            <span>Drop an image here, or choose one</span>
          </button>
          <Show when={error()}>
            <p class={styles.error} role="alert">{error()}</p>
          </Show>
          <div class={styles.menuActions}>
            <Show
              when={!isDefaultPhoto(props.account.pfp_url)}
              fallback={<span class={styles.menuNote}>You have the default photo.</span>}
            >
              <ConfirmMorph
                label="Remove photo"
                prompt="Use the default photo?"
                confirmLabel="Remove"
                pendingLabel="Removing"
                doneLabel="Removed"
                onConfirm={remove}
                resultTimeout={2400}
              />
            </Show>
            <Button variant="secondary" size="sm" onClick={choose} loading={uploading()}>Choose a photo</Button>
          </div>
        </PopoverContent>
      </Popover>
      <input
        ref={fileInput}
        type="file"
        accept={PHOTO_ACCEPT}
        class="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={event => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) void upload(file);
        }}
      />
    </div>
  );
}
