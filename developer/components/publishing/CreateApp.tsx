"use client";

import { useEffect, useState } from "react";
import { ArrowRight, Check } from "lucide-react";
import { useNavigate } from "./navigation";
import { api, useMutation, useResource } from "./api";
import type { App } from "./types";
import { Button, ErrorNotice, Input, Modal, SecretModal, Textarea } from "./ui";
export function CreateApp({ open, close }: { open: boolean; close: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [description, setDescription] = useState("");
  const [logo, setLogo] = useState("");
  const [checked, setChecked] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [created, setCreated] = useState("");
  const mutation = useMutation();
  useEffect(() => {
    const timer = setTimeout(() => setChecked(id), 300);
    return () => clearTimeout(timer);
  }, [id]);
  const availability = useResource<{ available: boolean }>(
    /^[a-z0-9_-]{3,30}$/.test(checked) ? `/apps/availability/${checked}` : null,
  );
  const valid = /^[a-z0-9_-]{3,30}$/.test(id);
  return (
    <>
      <Modal
        open={open && !secret}
        onClose={close}
        title="Create an app"
        description="Start with the basics. Your app exists immediately, and you can finish setting it up whenever you like."
      >
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            if (
              !name.trim() ||
              !valid ||
              id !== checked ||
              !availability.data?.available ||
              mutation.pending
            )
              return;
            const result = await mutation.run(() =>
              api<{ app: App; app_secret: string }>("/apps", {
                method: "POST",
                body: { name, app_id: id, description, logo },
              }),
            );
            if (result) {
              setCreated(result.app.app_id);
              setSecret(result.app_secret);
            }
          }}
        >
          <Input
            label="App name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={120}
            placeholder="My useful app"
          />
          <Input
            label="App ID"
            value={id}
            onChange={(e) => setId(e.target.value.toLowerCase())}
            required
            minLength={3}
            maxLength={30}
            pattern="[a-z0-9_-]{3,30}"
            placeholder="my-useful-app"
            description="3 to 30 lowercase letters, numbers, hyphens, or underscores. This cannot be changed."
            error={
              id && !valid
                ? "Choose a valid app ID."
                : id === checked &&
                    availability.data &&
                    !availability.data.available
                  ? "This app ID is already in use."
                  : undefined
            }
          />
          {id === checked && availability.data?.available && (
            <p className="small success row">
              <Check size={14} /> This app ID is available
            </p>
          )}
          {valid && id === checked && (
            <ErrorNotice
              error={availability.error}
              retry={availability.reload}
            />
          )}
          <Textarea
            label="Description (optional)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            maxLength={600}
          />
          <Input
            label="Logo URL (optional)"
            value={logo}
            onChange={(e) => setLogo(e.target.value)}
            type="url"
            placeholder="https://…"
          />
          <ErrorNotice error={mutation.error} />
          <Button
            type="submit"
            disabled={
              !name.trim() ||
              !valid ||
              !availability.data?.available ||
              id !== checked
            }
            loading={mutation.pending}
          >
            Create app <ArrowRight size={16} />
          </Button>
        </form>
      </Modal>
      <SecretModal
        secret={secret}
        onClose={() => {
          setSecret(null);
          close();
          navigate(`/apps/${created}/publishing`);
        }}
      />
    </>
  );
}