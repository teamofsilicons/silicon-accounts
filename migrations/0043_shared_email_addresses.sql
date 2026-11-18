-- Each Carbon picks one primary email. An address can be primary for one Carbon
-- and a verified secondary contact for others.
alter table account_emails drop constraint account_emails_pkey;
alter table account_emails add primary key (email, account_uuid);
create unique index account_emails_primary_address on account_emails (email) where is_primary;

-- Email-only operations must resolve to one identity. Prefer a proven address,
-- then its primary account. An ambiguous collection of secondaries identifies nobody.
create view account_email_owners as
select e.email, e.account_uuid, e.is_primary, e.verified_at
from account_emails e
where not exists (
    select 1 from account_emails other
    where other.email = e.email and other.account_uuid <> e.account_uuid
      and row(other.verified_at is not null, other.is_primary) >= row(e.verified_at is not null, e.is_primary)
);
