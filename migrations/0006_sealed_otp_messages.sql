-- Silicon Accounts — verification codes are no longer readable in outbound_messages.
--
-- 0001 to 0005 are applied and never edited; everything below builds on them.
--
-- otp_challenges keeps only an HMAC of each code, but the outbox kept the rendered email or SMS,
-- code included, after it was sent: a read of the database (a replica, a backup, a support
-- query) was enough to finish someone else's sign-in. From now on, with
-- ACCOUNTS_DELIVERY=providers, a code message is stored with the code replaced by •••••• in its
-- subject and bodies, and the real subject and bodies are sealed with the keyring
-- (ACCOUNTS_ENCRYPTION_KEYRING) in sealed_body. Only the sender opens them, to send; sealed_body
-- is cleared once the message is sent or has failed, except where the dev outbox is on (never in
-- production), which opens it to show the code. ACCOUNTS_DELIVERY=local (development only)
-- stores messages readable, as before.
alter table outbound_messages add column sealed_body bytea;

-- Code messages already handed to a provider, or given up on, keep no code.
update outbound_messages
   set subject   = regexp_replace(subject,   '(?<![0-9])[0-9]{6}(?![0-9])', '••••••', 'g'),
       text_body = regexp_replace(text_body, '(?<![0-9])[0-9]{6}(?![0-9])', '••••••', 'g'),
       html_body = regexp_replace(html_body, '(?<![0-9])[0-9]{6}(?![0-9])', '••••••', 'g')
 where purpose like 'otp\_%' and status in ('sent', 'failed');
