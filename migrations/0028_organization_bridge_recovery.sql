-- The receipt commits in the same transaction as the remote mutation.
-- Keeping the key/fingerprint after the encrypted response expires prevents duplicate work.
create table organization_bridge_receipts (
  scope text not null,
  key_hash bytea not null,
  request_hash bytea not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now()+interval '7 days',
  primary key(scope,key_hash)
);
