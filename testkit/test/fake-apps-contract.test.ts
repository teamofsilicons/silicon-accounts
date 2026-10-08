// fake-apps.json is consumed by accounts-seed and by Silicon Accounts' config validation:
// keep it valid against the spec (02-api.md SigninConfig/Branding) and the behaviours
// 05-testkit-e2e.md asks each app to exercise.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { loadDevCredentials } from '../src/credentials.ts';
import { buildFakeApps } from '../src/fake-apps/definitions.ts';
import { loadFakeAppsFile } from '../src/fake-apps/load.ts';
import { BRAND_FONTS, type Palette } from '../src/fake-apps/types.ts';
import { readFileSync } from 'node:fs';
import { FAKE_APPS_PATH } from '../src/credentials.ts';

const file = loadFakeAppsFile();
const apps = file.apps;
const byId = new Map(apps.map((a) => [a.app_id, a]));
const RESERVED = ['admin', 'administrator', 'root', 'system', 'support', 'help', 'security', 'accounts', 'account', 'silicon', 'silicons', 'carbon', 'carbons', 'api', 'www', 'mail', 'null', 'undefined', 'me', 'owner', 'staff'];

function luminance(hex: string): number {
  const channel = (i: number): number => {
    const c = Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('fake-apps.json', () => {
  test('is generated from src/fake-apps/definitions.ts and up to date', () => {
    const rendered = `${JSON.stringify(buildFakeApps(loadDevCredentials()), null, 2)}\n`;
    assert.equal(readFileSync(FAKE_APPS_PATH, 'utf8'), rendered, 'run `pnpm -C testkit gen:apps`');
  });

  test('has the 15 apps of the spec with valid, unique ids and long fixed secrets', () => {
    assert.deepEqual(
      apps.map((a) => a.app_id),
      ['briefcase', 'dm', 'commit', 'waveform', 'remind', 'browser', 'spacestation', 'interface', 'acme-notes', 'pixel-studio', 'ledgerly', 'campus-connect', 'legacy-crm', 'orbit-games', 'quill-docs'],
    );
    const secrets = new Set<string>();
    for (const app of apps) {
      assert.match(app.app_id, /^[a-z][a-z0-9-]{1,39}$/);
      assert.ok(app.secret.startsWith(`sa_app_${app.app_id}_`), app.app_id);
      assert.ok(app.secret.length >= 40, app.app_id);
      assert.ok(!secrets.has(app.secret));
      secrets.add(app.secret);
      assert.equal(app.status, 'active');
      assert.match(app.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      assert.match(app.owner_id, /^c:[a-z0-9_-]{3,30}$/);
      assert.ok(!RESERVED.includes(app.owner_id.slice(2)), app.owner_id);
      assert.match(app.owner_email, /^[^@\s]+@[^@\s]+\.[a-z]+$/);
      if (app.webhook_url) assert.match(app.webhook_secret ?? '', /^whsec_[A-Za-z0-9_-]{43}$/);
    }
    assert.equal(byId.get('briefcase')?.owner_id, 'c:saket');
    assert.equal(byId.get('briefcase')?.owner_email, 'saketdev12@example.test');
    assert.ok(apps.some((a) => a.owner_id === 'c:shubham'));
    assert.ok(apps.some((a) => a.owner_id === 'c:acme-dev'));
    assert.ok(apps.some((a) => a.owner_id === 'c:pixel-dev'));
    // One owner per email (the seeder creates owners from owner_id + owner_email).
    const ownerEmail = new Map<string, string>();
    for (const app of apps) {
      const seen = ownerEmail.get(app.owner_id);
      assert.ok(seen === undefined || seen === app.owner_email, `${app.owner_id} has two owner emails`);
      ownerEmail.set(app.owner_id, app.owner_email);
    }
  });

  test('logos are small inline SVG data URIs', () => {
    for (const app of apps) {
      for (const uri of [app.logo_url, app.logo_dark_url]) {
        assert.match(uri ?? '', /^data:image\/svg\+xml;base64,/);
        const svg = Buffer.from((uri ?? '').split(',')[1] ?? '', 'base64').toString('utf8');
        assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
        assert.ok(svg.length < 2_000, `${app.app_id} logo is ${svg.length} bytes`);
        assert.doesNotMatch(svg, /<script|href=/i);
      }
    }
  });

  test('sign-in defaults are valid SigninConfig fragments', () => {
    const fields = ['email', 'phone', 'dob', 'timezone'];
    for (const app of apps) {
      const config = app.signin_defaults;
      const enabled = Object.entries(config.methods ?? {})
        .filter(([, on]) => on)
        .map(([m]) => m);
      assert.ok(enabled.length > 0, `${app.app_id} enables no method`);
      for (const m of config.method_order ?? []) assert.ok(enabled.includes(m), `${app.app_id}: method_order lists disabled ${m}`);
      assert.deepEqual(config.redirect_uris, [`${file.fake_app_server}/${app.app_id}/callback`]);
      assert.deepEqual(config.allowed_origins, [file.fake_app_server]);
      const required = config.required_fields ?? [];
      const optional = config.optional_fields ?? [];
      for (const f of [...required, ...optional]) assert.ok(fields.includes(f), `${app.app_id}: unknown field ${f}`);
      assert.equal(required.filter((f) => optional.includes(f)).length, 0, `${app.app_id}: required and optional overlap`);
      for (const url of [config.copy?.terms_url, config.copy?.privacy_url]) if (url) assert.match(url, /^https:\/\//);
      if (config.google?.mode === 'byo') {
        assert.ok(config.google.client_id && config.google.client_secret, `${app.app_id}: BYO Google needs client_id + client_secret`);
      }
      if (config.apple?.mode === 'byo') {
        assert.ok(config.apple.services_id && config.apple.team_id && config.apple.key_id, `${app.app_id}: BYO Apple ids`);
        assert.match(config.apple.private_key ?? '', /^-----BEGIN PRIVATE KEY-----\n/);
      }
      const branding = config.branding;
      if (!branding) continue;
      if (branding.font_family) assert.ok(BRAND_FONTS.includes(branding.font_family), branding.font_family);
      if (branding.heading_font_family) assert.ok(BRAND_FONTS.includes(branding.heading_font_family), branding.heading_font_family);
      if (branding.radius !== undefined) assert.ok(branding.radius >= 0 && branding.radius <= 40);
      if (branding.logo_height !== undefined) assert.ok(branding.logo_height >= 16 && branding.logo_height <= 96);
      for (const [mode, palette] of [
        ['light', branding.light],
        ['dark', branding.dark],
      ] as Array<[string, Palette | undefined]>) {
        if (!palette) continue;
        for (const [key, value] of Object.entries(palette)) assert.match(value, /^#[0-9A-F]{6}$/, `${app.app_id} ${mode}.${key}`);
        // The server rejects < 3:1; keep text pairs at AA (4.5:1).
        assert.ok(contrast(palette.primary, palette.primary_foreground) >= 4.5, `${app.app_id} ${mode} primary contrast ${contrast(palette.primary, palette.primary_foreground).toFixed(2)}`);
        assert.ok(contrast(palette.foreground, palette.background) >= 4.5, `${app.app_id} ${mode} text contrast ${contrast(palette.foreground, palette.background).toFixed(2)}`);
        assert.ok(contrast(palette.muted, palette.background) >= 3, `${app.app_id} ${mode} muted contrast`);
      }
    }
  });

  test('each app exercises what 05-testkit-e2e.md asks of it', () => {
    const app = (id: string) => byId.get(id)!.signin_defaults;
    const creds = loadDevCredentials();
    assert.deepEqual(app('briefcase').methods, { email: true, phone: true, google: true, apple: true });
    assert.deepEqual(app('briefcase').required_fields, ['email']);
    assert.ok(byId.get('briefcase')?.webhook_url);
    assert.deepEqual(app('dm').required_fields, ['phone']);
    assert.deepEqual(byId.get('dm')?.testkit.proofs.user_verification_issuer_to, ['briefcase']);
    assert.deepEqual(byId.get('commit')?.testkit.proofs.app_verification_issuer_to, ['remind', 'waveform']);
    assert.deepEqual(app('waveform').methods, { google: true, apple: true, email: false, phone: false });
    assert.deepEqual(app('remind').methods, { email: true, phone: false, google: false, apple: false });
    assert.deepEqual(app('spacestation').optional_fields, ['timezone']);
    assert.equal(app('interface').remember_browser, true);
    assert.equal(byId.get('interface')?.testkit.authorize_params.prompt, 'select_account');
    const acme = app('acme-notes');
    assert.equal(acme.google?.mode, 'byo');
    assert.equal(acme.google?.client_id, creds.byo['acme-notes'].google.client_id);
    assert.equal(acme.google?.client_secret, creds.byo['acme-notes'].google.client_secret);
    assert.deepEqual([acme.branding?.theme, acme.branding?.heading_font_family, acme.branding?.radius, acme.branding?.layout, acme.branding?.background_style], ['dark', 'Fraunces', 28, 'split', 'grain']);
    assert.ok(acme.branding?.logo_url);
    const pixel = app('pixel-studio').branding;
    assert.deepEqual([pixel?.corner_style, pixel?.button_style, pixel?.font_family, pixel?.layout, pixel?.background_style], ['sharp', 'outline', 'Space Grotesk', 'minimal', 'dots']);
    assert.equal(pixel?.light?.primary, '#E5007E');
    assert.deepEqual(app('ledgerly').required_fields, ['phone', 'dob']);
    assert.deepEqual(app('ledgerly').optional_fields, ['timezone']);
    assert.equal(app('ledgerly').allow_signup, true);
    assert.deepEqual(app('campus-connect').allowed_email_domains, ['university.test']);
    assert.equal(app('campus-connect').google?.hosted_domain, 'university.test');
    assert.equal(app('legacy-crm').allow_signup, false);
    const orbit = app('orbit-games');
    assert.deepEqual(orbit.methods, { apple: true, email: false, phone: false, google: false });
    assert.equal(orbit.apple?.mode, 'byo');
    assert.equal(orbit.apple?.services_id, creds.byo['orbit-games'].apple.services_id);
    assert.equal(orbit.apple?.private_key, creds.byo['orbit-games'].apple.private_key_pem);
    assert.equal(orbit.branding?.density, 'compact');
    assert.equal(byId.get('quill-docs')?.testkit.integration, 'sdk');
    assert.match(byId.get('quill-docs')?.testkit.authorize_params.scope ?? '', /\bopenid\b/);
    assert.deepEqual(app('quill-docs').optional_fields, ['email']);
  });

  test('dev credentials are mock-only and well-formed', () => {
    const creds = loadDevCredentials();
    assert.match(creds.managed.google.client_id, /^mock-google-[a-z0-9-]+\.invalid$/);
    assert.match(creds.managed.google.client_secret, /^mock-google-/);
    assert.match(creds.managed.apple.team_id, /^[A-Z0-9]{10}$/);
    assert.match(creds.managed.apple.key_id, /^[A-Z0-9]{10}$/);
    assert.match(creds.managed.apple.private_key_pem, /^-----BEGIN PRIVATE KEY-----/);
    assert.match(creds.messaging.twilio.account_sid, /^mock-twilio-/);
    assert.match(creds.messaging.twilio.messaging_service_sid, /^MG[0-9a-f]{32}$/);
    assert.notEqual(creds.managed.google.client_id, creds.byo['acme-notes'].google.client_id);
  });
});
