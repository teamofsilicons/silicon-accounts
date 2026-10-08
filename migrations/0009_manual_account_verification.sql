-- Manual account-review requests for eligibility to host app authorization on an own domain.
-- This records a request only; it creates no verified-account flag or domain permission.
create table account_verification_requests (
    id uuid primary key,
    account_uuid text collate "C" not null references accounts(uuid),
    context_app_id text not null references apps(app_id),
    reason text not null check (char_length(btrim(reason)) between 1 and 5000),
    status text not null default 'pending' check (status in ('pending','approved','rejected')),
    submitted_at timestamptz not null default now(),
    response_expected_by timestamptz not null default (now() + interval '48 hours'),
    reviewed_at timestamptz,
    check ((status = 'pending') = (reviewed_at is null))
);
create unique index account_verification_one_pending_idx
    on account_verification_requests(account_uuid) where status='pending';
create index account_verification_requests_account_idx
    on account_verification_requests(account_uuid, submitted_at desc, id desc);

-- Exact durable outbox identities let operators inspect provider acceptance independently.
create table account_verification_request_notifications (
    request_id uuid not null references account_verification_requests(id),
    recipient text not null check (recipient in ('lords@teamofsilicons.com','saket@teamofsilicons.com')),
    message_id uuid not null unique references outbound_messages(id),
    primary key(request_id,recipient)
);
