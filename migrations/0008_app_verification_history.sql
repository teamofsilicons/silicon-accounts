-- Retained proof events, without token material, for managed-app verification history.
create index audit_log_proof_history_idx on audit_log (app_id, target_id, at desc, id desc)
where target_kind = 'proof'
  and action in ('proof.issued', 'proof.refreshed', 'proof.revoked', 'proof.refresh_token_reused');
create index proof_families_ata_page_idx on proof_families (created_at desc, id desc)
where kind = 'ata';
