-- The broker-owned Accounts browser session is never given to the Interface.
-- Record its ID so expiry can end the internal session as well as erase cookies.
alter table verified_interface_auth_flows add column browser_session_id uuid references browser_sessions(id);
