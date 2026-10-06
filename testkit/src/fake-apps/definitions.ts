// The 15 fake apps that stand in for Silicon Apps until it ships. Each one has a fixed
// app_id and secret (they become real apps later, keeping app_id and user base) and a
// sign-in setup chosen so that, together, they exercise every behaviour of Silicon
// Accounts. `pnpm -C testkit gen:apps` turns this file into testkit/fake-apps.json.

import type { DevCredentials } from '../credentials.ts';
import { logoDataUri } from './logos.ts';
import type { Branding, FakeAppsFile, SiliconAppsApp, SigninDefaults, TestkitMeta } from './types.ts';

/** Where the fake app server runs by default; redirect URIs, origins and webhooks point here. */
export const FAKE_APP_SERVER = 'http://127.0.0.1:8593';

const FIRST_PARTY_TERMS = 'https://teamofsilicons.com/legal/terms';
const FIRST_PARTY_PRIVACY = 'https://teamofsilicons.com/legal/privacy';

/** Fixed per-app secrets. Changing one breaks every environment seeded with it. */
const SECRETS: Record<string, { secret: string; webhook_secret: string }> = {
  briefcase: { secret: 'sa_app_briefcase_AMVzlxdzf7qyZky8KlQdEekYO2kKkq7QhPhqWvWK', webhook_secret: 'whsec_xp1TbBVqPjD74gtqOKEkhRvHYvz8rtBjWjoUxEdLmn0' },
  dm: { secret: 'sa_app_dm_ekYvM9LJrnrpe2GqvbvAhWfdMD6SzVv1hToGmmUZ', webhook_secret: 'whsec_zUpC02FM_og8hd3mYrqekmGvWZvl1gUFbMIJ2AbtO_E' },
  commit: { secret: 'sa_app_commit_iDcYJWSZmonuzCssCPanX74SX41q3rpADf0wmbYs', webhook_secret: 'whsec_BZ5Jw79Mkod1ARFH4UPiiC7j-XxJaAzwbBCIS62gW18' },
  waveform: { secret: 'sa_app_waveform_wocVaVMBmPDCz7WfHHtsFLeYIOZqFffOCKQkIIMQ', webhook_secret: 'whsec_8HdqMnnAJy-TUKvdwQiOsbakpzAkvu2J5DmNnwmp0vM' },
  remind: { secret: 'sa_app_remind_N7j6xLRgBs2NlUIBDzPrYcxMQUxeSNZhxSBUj6sx', webhook_secret: 'whsec_vt-J0XTLv2wNHTPvNkCwx4mmfysBKKgYqrJcrSx_Bmw' },
  browser: { secret: 'sa_app_browser_Gcyai0co4PEeDrZ21GGVGoYWoNhWfjgMPcrsDq6M', webhook_secret: 'whsec_bxdXfcyp8Z03bs4T7eQgEwHV4efQYl7Lo4jxqYuUEh0' },
  spacestation: { secret: 'sa_app_spacestation_8uZqmtgdd4pbCxfISaghIGnaRbWFp2OaJ7FpyQWE', webhook_secret: 'whsec_OFXBk7vlznGcYV1aYim-__4ilXFaOHaezIhqWjhfPho' },
  interface: { secret: 'sa_app_interface_h8CnlmtVhqHDSPMu6CRxSntWpqkYdfyISJaxbjwD', webhook_secret: 'whsec_B0NrDM4gN8Skzk4kVbiPeKVUAMqB7EjLeqVU5cdL0Rc' },
  'acme-notes': { secret: 'sa_app_acme-notes_s1smais9iGzOwxRYSMjkf9oTbmFVGGEqu6wpAa2X', webhook_secret: 'whsec_CC5WxebmSGGI_pS3Zk9i5WgWXUidY6-18m8c57y45F8' },
  'pixel-studio': { secret: 'sa_app_pixel-studio_iw4ejt8HVvf4qO35yjLKu1nxobVv9a6zh0CGvh0T', webhook_secret: 'whsec_3wvH28FgxfTQMlqL7uug1zDYbHjUKWY3qwAVk45NWB8' },
  ledgerly: { secret: 'sa_app_ledgerly_FefJ6PgP4U9HBFi3LvjyeCLJdxyE1aNf28FXgSSo', webhook_secret: 'whsec_hGZYsYHnQDsVZjcJVluA0o-uaoh1t9wm2RmeS6TRjDw' },
  'campus-connect': { secret: 'sa_app_campus-connect_BuAE0ltJwQNSEcEZCOrIDLRY1AQb8MbnJjBPIMTU', webhook_secret: 'whsec_eiEICaDQ8Xrvd0TjrmVbLorReLrKSBM4lCmLudjZ00g' },
  'legacy-crm': { secret: 'sa_app_legacy-crm_insfxFVisZEd3zZCSDUesIz4fgkKI4I2l6MPN6bk', webhook_secret: 'whsec_9LTjWJSN2AyinLqBZXh7YpIGSnCsFwOPaABqneRw50M' },
  'orbit-games': { secret: 'sa_app_orbit-games_pG2eHzDJBwix7tAgTMLESp7hdV2HW43PoHpAtBeH', webhook_secret: 'whsec_PtLTpSoLSK3dp2tZxWjoajOeVrl0vOelZ6jMZYpEtgE' },
  'quill-docs': { secret: 'sa_app_quill-docs_Xkd6ZTgdHg9FEhMqpHXj8OG3ZL25G9Av90l3jIr5', webhook_secret: 'whsec_ir2bifLBrfDIdqH2yGD0-YfnSlt3kIkcnoqyQWaOE04' },
};

export const OWNERS = {
  saket: { owner_id: 'c:saket', owner_email: 'saketdev12@example.test' },
  shubham: { owner_id: 'c:shubham', owner_email: 'shubhastro2@example.test' },
  acme: { owner_id: 'c:acme-dev', owner_email: 'dev@acme-notes.test' },
  pixel: { owner_id: 'c:pixel-dev', owner_email: 'dev@pixel-studio.test' },
  ledgerly: { owner_id: 'c:ledgerly-dev', owner_email: 'dev@ledgerly.test' },
  campus: { owner_id: 'c:campus-it', owner_email: 'it@university.test' },
  crm: { owner_id: 'c:crm-dev', owner_email: 'dev@legacy-crm.test' },
  orbit: { owner_id: 'c:orbit-dev', owner_email: 'dev@orbit-games.test' },
  quill: { owner_id: 'c:quill-dev', owner_email: 'dev@quill-docs.test' },
} as const;

interface Draft {
  app_id: string;
  name: string;
  description: string;
  owner: { owner_id: string; owner_email: string };
  created_at: string;
  webhook: boolean;
  signin: SigninDefaults;
  testkit: Omit<TestkitMeta, 'proofs' | 'silicon_slt' | 'authorize_params'> & Partial<Pick<TestkitMeta, 'proofs' | 'silicon_slt' | 'authorize_params'>>;
}

function noProofs(): TestkitMeta['proofs'] {
  return { obo_issuer_to: [], obo_receiver: false, ata_issuer_to: [], ata_receiver: false };
}

function drafts(credentials: DevCredentials): Draft[] {
  const acmeGoogle = credentials.byo['acme-notes'].google;
  const orbitApple = credentials.byo['orbit-games'].apple;

  const acmeBranding: Partial<Branding> = {
    theme: 'dark',
    logo_height: 40,
    show_app_name: true,
    font_family: 'Inter',
    heading_font_family: 'Fraunces',
    corner_style: 'squircle',
    radius: 28,
    button_style: 'solid',
    layout: 'split',
    background_style: 'grain',
    density: 'comfortable',
    light: { primary: '#8A4F0F', primary_foreground: '#FFFBF5', background: '#FBF7F0', surface: '#FFFFFF', foreground: '#2B2118', muted: '#6E5E4C', border: '#E9DFD0', danger: '#B42318' },
    dark: { primary: '#E8B04B', primary_foreground: '#1A1410', background: '#16130F', surface: '#211D18', foreground: '#F3ECE2', muted: '#B3A796', border: '#3A332B', danger: '#F97066' },
  };

  const pixelBranding: Partial<Branding> = {
    theme: 'light',
    logo_height: 44,
    show_app_name: true,
    font_family: 'Space Grotesk',
    heading_font_family: 'Space Grotesk',
    corner_style: 'sharp',
    radius: 0,
    button_style: 'outline',
    layout: 'minimal',
    background_style: 'dots',
    density: 'comfortable',
    light: { primary: '#E5007E', primary_foreground: '#FFFFFF', background: '#FFF5FA', surface: '#FFFFFF', foreground: '#1D0B16', muted: '#7D4A66', border: '#F5B8D6', danger: '#C00021' },
    dark: { primary: '#FF4FAE', primary_foreground: '#1D0B16', background: '#1D0B16', surface: '#2A1221', foreground: '#FFE8F4', muted: '#E2A3C4', border: '#5A2A44', danger: '#FF6B6B' },
  };

  const ledgerlyBranding: Partial<Branding> = {
    theme: 'light',
    font_family: 'IBM Plex Sans',
    heading_font_family: 'IBM Plex Sans',
    corner_style: 'rounded',
    radius: 10,
    button_style: 'solid',
    layout: 'card',
    background_style: 'gradient',
    light: { primary: '#14532D', primary_foreground: '#F0FDF4', background: '#F4F8F5', surface: '#FFFFFF', foreground: '#0F1F17', muted: '#4B6356', border: '#D5E3DA', danger: '#B42318' },
    dark: { primary: '#4ADE80', primary_foreground: '#052E16', background: '#0B1510', surface: '#13221A', foreground: '#ECFDF5', muted: '#9DBBA9', border: '#24392D', danger: '#F97066' },
  };

  const campusBranding: Partial<Branding> = {
    font_family: 'Inter',
    heading_font_family: 'Source Serif 4',
    corner_style: 'rounded',
    radius: 14,
    layout: 'card',
    background_style: 'plain',
    light: { primary: '#7C2D12', primary_foreground: '#FFF7ED', background: '#FFFBF7', surface: '#FFFFFF', foreground: '#2A1A12', muted: '#6B5246', border: '#EBDCD2', danger: '#B42318' },
    dark: { primary: '#FDBA74', primary_foreground: '#2A1206', background: '#1C1411', surface: '#29201B', foreground: '#FFF7ED', muted: '#C8B2A5', border: '#41332B', danger: '#F97066' },
  };

  const orbitBranding: Partial<Branding> = {
    theme: 'dark',
    logo_height: 48,
    font_family: 'DM Sans',
    heading_font_family: 'DM Sans',
    corner_style: 'squircle',
    radius: 22,
    button_style: 'soft',
    layout: 'card',
    background_style: 'gradient',
    density: 'compact',
    light: { primary: '#4338CA', primary_foreground: '#FFFFFF', background: '#F5F6FF', surface: '#FFFFFF', foreground: '#14123A', muted: '#55528A', border: '#DADCF5', danger: '#BE123C' },
    dark: { primary: '#22D3EE', primary_foreground: '#06222B', background: '#0B0A1F', surface: '#15133A', foreground: '#EEF2FF', muted: '#A5B4FC', border: '#2E2A6B', danger: '#FB7185' },
  };

  const quillBranding: Partial<Branding> = {
    font_family: 'Geist',
    heading_font_family: 'Instrument Serif',
    corner_style: 'squircle',
    radius: 16,
    button_style: 'solid',
    layout: 'card',
    background_style: 'plain',
    light: { primary: '#3B1D6E', primary_foreground: '#FFFDF9', background: '#FCFAFF', surface: '#FFFFFF', foreground: '#1F1630', muted: '#625775', border: '#E6E0F0', danger: '#B42318' },
    dark: { primary: '#C4B5FD', primary_foreground: '#1F1035', background: '#16121F', surface: '#211B2E', foreground: '#F5F3FF', muted: '#B3A9C9', border: '#372D4A', danger: '#F97066' },
  };

  return [
    {
      app_id: 'briefcase',
      name: 'Briefcase',
      description: 'File storage for Carbons and Silicons: upload, share and keep every file in one place.',
      owner: OWNERS.saket,
      created_at: '2026-09-01T09:00:00.000Z',
      webhook: true,
      signin: {
        methods: { email: true, phone: true, google: true, apple: true },
        method_order: ['google', 'apple', 'email', 'phone'],
        google: { mode: 'managed', prompt: 'select_account' },
        apple: { mode: 'managed' },
        required_fields: ['email'],
        optional_fields: ['timezone'],
        allow_signup: true,
        remember_browser: true,
        copy: { title: 'Sign in to Briefcase', subtitle: 'Your files, for every Carbon and Silicon.', terms_url: FIRST_PARTY_TERMS, privacy_url: FIRST_PARTY_PRIVACY, support_email: 'support@teamofsilicons.com' },
      },
      testkit: {
        category: 'files',
        purpose: 'Every sign-in method with the default Silicon Accounts look; the OBO receiver (dm saves files here).',
        exercises: ['email + phone + Google + Apple (managed)', 'required email', 'default branding (screenshot baseline)', 'webhooks', 'OBO receiver', 'Silicon SLT sign-in'],
        integration: 'hosted',
        proofs: { obo_issuer_to: [], obo_receiver: true, ata_issuer_to: [], ata_receiver: false },
        silicon_slt: true,
        accent: '#2F4B7C',
      },
    },
    {
      app_id: 'dm',
      name: 'DM',
      description: 'Direct messages between Carbons and Silicons, with files saved straight to Briefcase.',
      owner: OWNERS.shubham,
      created_at: '2026-09-01T09:05:00.000Z',
      webhook: true,
      signin: {
        methods: { email: true, phone: true, google: false, apple: false },
        method_order: ['phone', 'email'],
        required_fields: ['phone'],
        optional_fields: ['email', 'timezone'],
        allow_signup: true,
        remember_browser: true,
        branding: {
          light: { primary: '#17775C', primary_foreground: '#FFFDF9', background: '#FFFDF9', surface: '#FFFFFF', foreground: '#353432', muted: '#6F6B66', border: '#E8E3DA', danger: '#B42318' },
          dark: { primary: '#34B38A', primary_foreground: '#06231A', background: '#2A2927', surface: '#353432', foreground: '#FFFDF9', muted: '#B5B0A8', border: '#4A4845', danger: '#F97066' },
        },
        copy: { title: 'Sign in to DM', subtitle: 'Messages between Carbons and Silicons.', terms_url: FIRST_PARTY_TERMS, privacy_url: FIRST_PARTY_PRIVACY, support_email: 'support@teamofsilicons.com' },
      },
      testkit: {
        category: 'messaging',
        purpose: 'Requires a phone number (asks for it when the Carbon has none); issues OBO proofs to Briefcase.',
        exercises: ['phone required → requirements step', 'email + phone only', 'OBO issuer (dm → briefcase)', 'webhooks'],
        integration: 'hosted',
        proofs: { obo_issuer_to: ['briefcase'], obo_receiver: false, ata_issuer_to: [], ata_receiver: false },
        silicon_slt: true,
        accent: '#17775C',
      },
    },
    {
      app_id: 'commit',
      name: 'Commit',
      description: 'Todos that ship. Commit pings Remind and Waveform when work is due.',
      owner: OWNERS.saket,
      created_at: '2026-09-01T09:10:00.000Z',
      webhook: true,
      signin: {
        methods: { email: true, google: true, phone: false, apple: false },
        method_order: ['google', 'email'],
        google: { mode: 'managed', prompt: 'select_account' },
        required_fields: ['email'],
        optional_fields: ['timezone'],
        allow_signup: true,
        remember_browser: true,
        copy: { title: 'Sign in to Commit', subtitle: 'Todos that ship.', terms_url: FIRST_PARTY_TERMS, privacy_url: FIRST_PARTY_PRIVACY, support_email: 'support@teamofsilicons.com' },
      },
      testkit: {
        category: 'todos',
        purpose: 'Email + Google; issues ATA proofs to Remind and Waveform.',
        exercises: ['email + Google (managed)', 'ATA issuer (commit → remind, waveform)', 'continue-as across apps'],
        integration: 'hosted',
        proofs: { obo_issuer_to: [], obo_receiver: false, ata_issuer_to: ['remind', 'waveform'], ata_receiver: false },
        silicon_slt: true,
        accent: '#5B4BD5',
      },
    },
    {
      app_id: 'waveform',
      name: 'Waveform',
      description: 'Voice notes and calls for Carbons and Silicons.',
      owner: OWNERS.shubham,
      created_at: '2026-09-01T09:15:00.000Z',
      webhook: true,
      signin: {
        methods: { google: true, apple: true, email: false, phone: false },
        method_order: ['apple', 'google'],
        google: { mode: 'managed', prompt: 'select_account' },
        apple: { mode: 'managed' },
        required_fields: [],
        optional_fields: ['email', 'timezone'],
        allow_signup: true,
        remember_browser: true,
        copy: { title: 'Sign in to Waveform', subtitle: 'Voice, for Carbons and Silicons.', terms_url: FIRST_PARTY_TERMS, privacy_url: FIRST_PARTY_PRIVACY, support_email: 'support@teamofsilicons.com' },
      },
      testkit: {
        category: 'voice',
        purpose: 'Google + Apple only (no codes); receives ATA proofs from Commit.',
        exercises: ['Google + Apple only, Apple first', 'profile-only required scopes', 'ATA receiver'],
        integration: 'hosted',
        proofs: { obo_issuer_to: [], obo_receiver: false, ata_issuer_to: [], ata_receiver: true },
        silicon_slt: false,
        accent: '#C2410C',
      },
    },
    {
      app_id: 'remind',
      name: 'Remind',
      description: 'Reminders on your own clock, for Carbons and the Silicons that work for them.',
      owner: OWNERS.saket,
      created_at: '2026-09-01T09:20:00.000Z',
      webhook: true,
      signin: {
        methods: { email: true, phone: false, google: false, apple: false },
        method_order: ['email'],
        required_fields: ['timezone'],
        optional_fields: ['email'],
        allow_signup: true,
        remember_browser: true,
        copy: { title: 'Sign in to Remind', subtitle: 'Reminders on your own clock.', terms_url: FIRST_PARTY_TERMS, privacy_url: FIRST_PARTY_PRIVACY, support_email: 'support@teamofsilicons.com' },
      },
      testkit: {
        category: 'reminders',
        purpose: 'Email only; Silicons sign in with short-lived tokens; receives ATA proofs from Commit.',
        exercises: ['email only', 'required timezone (always present)', 'Silicon SLT sign-in', 'ATA receiver'],
        integration: 'hosted',
        proofs: { obo_issuer_to: [], obo_receiver: false, ata_issuer_to: [], ata_receiver: true },
        silicon_slt: true,
        accent: '#A16207',
      },
    },
    {
      app_id: 'browser',
      name: 'Browser',
      description: 'The web browser built for Silicons, with a Carbon watching over.',
      owner: OWNERS.shubham,
      created_at: '2026-09-01T09:25:00.000Z',
      webhook: true,
      signin: {
        methods: { email: true, google: true, phone: false, apple: false },
        method_order: ['email', 'google'],
        google: { mode: 'managed', prompt: 'select_account' },
        required_fields: [],
        optional_fields: ['timezone'],
        allow_signup: true,
        remember_browser: true,
        copy: { title: 'Sign in to Browser', subtitle: 'The browser built for Silicons.', terms_url: FIRST_PARTY_TERMS, privacy_url: FIRST_PARTY_PRIVACY, support_email: 'support@teamofsilicons.com' },
      },
      testkit: {
        category: 'silicon browser',
        purpose: 'Silicon-heavy app: most sign-ins are Silicons using short-lived tokens.',
        exercises: ['Silicon SLT sign-in at volume', 'custodian change webhooks', 'email + Google'],
        integration: 'hosted',
        silicon_slt: true,
        accent: '#0E7490',
      },
    },
    {
      app_id: 'spacestation',
      name: 'Space Station',
      description: 'Telemetry for every Silicon: context-rich events, opted in by default.',
      owner: OWNERS.saket,
      created_at: '2026-09-01T09:30:00.000Z',
      webhook: false,
      signin: {
        methods: { email: true, phone: false, google: false, apple: false },
        method_order: ['email'],
        required_fields: [],
        optional_fields: ['timezone'],
        allow_signup: true,
        remember_browser: false,
        copy: { title: 'Sign in to Space Station', subtitle: 'Telemetry for every Silicon.', terms_url: FIRST_PARTY_TERMS, privacy_url: FIRST_PARTY_PRIVACY, support_email: 'support@teamofsilicons.com' },
      },
      testkit: {
        category: 'telemetry',
        purpose: 'Email only with optional timezone; no "continue as" (remember_browser false); no webhook.',
        exercises: ['optional timezone toggle', 'remember_browser false', 'app without a webhook'],
        integration: 'hosted',
        silicon_slt: true,
        accent: '#111827',
      },
    },
    {
      app_id: 'interface',
      name: 'Silicon Interface',
      description: 'Talk to your Silicons: chat, approvals and everything they are working on.',
      owner: OWNERS.shubham,
      created_at: '2026-09-01T09:35:00.000Z',
      webhook: true,
      signin: {
        methods: { email: true, phone: true, google: true, apple: true },
        method_order: ['google', 'apple', 'email', 'phone'],
        google: { mode: 'managed', prompt: 'select_account' },
        apple: { mode: 'managed' },
        required_fields: [],
        optional_fields: ['email', 'phone', 'timezone'],
        allow_signup: true,
        remember_browser: true,
        copy: { title: 'Sign in to Silicon Interface', subtitle: 'Talk to your Silicons.', terms_url: FIRST_PARTY_TERMS, privacy_url: FIRST_PARTY_PRIVACY, support_email: 'support@teamofsilicons.com' },
      },
      testkit: {
        category: 'silicon interface',
        purpose: 'All methods, remember browser, and prompt=select_account on its sign-in links (the "Continue as" chooser).',
        exercises: ['every method', 'remember_browser + prompt=select_account', 'consent optional toggles (email, phone, timezone)'],
        integration: 'hosted',
        authorize_params: { prompt: 'select_account' },
        silicon_slt: true,
        accent: '#353432',
      },
    },
    {
      app_id: 'acme-notes',
      name: 'Acme Notes',
      description: 'Fast, private notes that sync everywhere, by Acme.',
      owner: OWNERS.acme,
      created_at: '2026-09-05T14:00:00.000Z',
      webhook: true,
      signin: {
        methods: { google: true, email: true, phone: false, apple: false },
        method_order: ['google', 'email'],
        google: { mode: 'byo', client_id: acmeGoogle.client_id, client_secret: acmeGoogle.client_secret, prompt: 'select_account', hosted_domain: null },
        required_fields: ['email'],
        optional_fields: ['timezone'],
        allow_signup: true,
        remember_browser: true,
        branding: acmeBranding,
        copy: { title: 'Welcome back to Acme Notes', subtitle: 'Sign in to pick up where you left off.', terms_url: 'https://acme-notes.test/terms', privacy_url: 'https://acme-notes.test/privacy', support_email: 'help@acme-notes.test' },
      },
      testkit: {
        category: 'external (notes)',
        purpose: 'Bring-your-own Google client (the mock must see acme’s client id) and heavy custom branding.',
        exercises: ['Google BYO', 'dark theme, Fraunces headings, radius 28, split layout, grain background, logo'],
        integration: 'hosted',
        silicon_slt: false,
        accent: '#8A4F0F',
      },
    },
    {
      app_id: 'pixel-studio',
      name: 'Pixel Studio',
      description: 'A loud little design tool for pixel art and posters.',
      owner: OWNERS.pixel,
      created_at: '2026-09-06T11:30:00.000Z',
      webhook: true,
      signin: {
        methods: { email: true, google: true, apple: true, phone: false },
        method_order: ['email', 'google', 'apple'],
        google: { mode: 'managed', prompt: 'select_account' },
        apple: { mode: 'managed' },
        required_fields: ['email'],
        optional_fields: [],
        allow_signup: true,
        remember_browser: true,
        branding: pixelBranding,
        copy: { title: 'PIXEL STUDIO', subtitle: 'Sign in. Make loud things.', terms_url: 'https://pixel-studio.test/terms', privacy_url: 'https://pixel-studio.test/privacy', support_email: 'hi@pixel-studio.test' },
      },
      testkit: {
        category: 'external (design)',
        purpose: 'Loud branding at the extremes: pink primary, sharp corners, outline buttons, Space Grotesk, minimal layout, dots.',
        exercises: ['extreme branding still shows Powered by Silicon Accounts', 'outline buttons', 'radius 0'],
        integration: 'iframe',
        silicon_slt: false,
        accent: '#E5007E',
      },
    },
    {
      app_id: 'ledgerly',
      name: 'Ledgerly',
      description: 'Bookkeeping for freelancers: invoices, expenses and taxes in one ledger.',
      owner: OWNERS.ledgerly,
      created_at: '2026-09-08T08:00:00.000Z',
      webhook: true,
      signin: {
        methods: { email: true, phone: true, google: true, apple: false },
        method_order: ['email', 'phone', 'google'],
        google: { mode: 'managed', prompt: 'select_account' },
        required_fields: ['phone', 'dob'],
        optional_fields: ['timezone'],
        allow_signup: true,
        remember_browser: true,
        branding: ledgerlyBranding,
        copy: { title: 'Sign in to Ledgerly', subtitle: 'We need your phone and date of birth to keep your books safe.', terms_url: 'https://ledgerly.test/terms', privacy_url: 'https://ledgerly.test/privacy', support_email: 'support@ledgerly.test' },
      },
      testkit: {
        category: 'external (finance)',
        purpose: 'Requires phone and date of birth, optional timezone, sign-up allowed.',
        exercises: ['requirements: phone + dob', 'optional timezone', 'allow_signup true'],
        integration: 'hosted',
        silicon_slt: false,
        accent: '#14532D',
      },
    },
    {
      app_id: 'campus-connect',
      name: 'Campus Connect',
      description: 'Courses, clubs and timetables for university.test students and staff.',
      owner: OWNERS.campus,
      created_at: '2026-09-09T10:00:00.000Z',
      webhook: true,
      signin: {
        methods: { email: true, google: true, phone: false, apple: false },
        method_order: ['google', 'email'],
        google: { mode: 'managed', prompt: 'select_account', hosted_domain: 'university.test' },
        required_fields: ['email'],
        optional_fields: [],
        allowed_email_domains: ['university.test'],
        allow_signup: true,
        remember_browser: true,
        branding: campusBranding,
        copy: { title: 'Campus Connect', subtitle: 'Sign in with your university.test address.', terms_url: 'https://university.test/terms', privacy_url: 'https://university.test/privacy', support_email: 'it@university.test' },
      },
      testkit: {
        category: 'external (education)',
        purpose: 'Only university.test addresses may sign in (email and Google); Google hosted domain hint.',
        exercises: ['allowed_email_domains', 'Google hosted_domain', 'email_domain_not_allowed error'],
        integration: 'hosted',
        silicon_slt: false,
        accent: '#7C2D12',
      },
    },
    {
      app_id: 'legacy-crm',
      name: 'Legacy CRM',
      description: 'A long-running CRM moving its existing customers onto Silicon Accounts.',
      owner: OWNERS.crm,
      created_at: '2026-09-10T16:00:00.000Z',
      webhook: true,
      signin: {
        methods: { email: true, phone: true, google: false, apple: false },
        method_order: ['email', 'phone'],
        required_fields: ['email'],
        optional_fields: ['phone', 'dob', 'timezone'],
        allow_signup: false,
        remember_browser: true,
        copy: { title: 'Sign in to Legacy CRM', subtitle: 'Use the email or phone your account manager has on file.', terms_url: 'https://legacy-crm.test/terms', privacy_url: 'https://legacy-crm.test/privacy', support_email: 'support@legacy-crm.test' },
      },
      testkit: {
        category: 'external (crm)',
        purpose: 'Import target for the dirty CSV fixtures; sign-up is closed so only imported (or existing) accounts get in.',
        exercises: ['user imports (clean, dirty, unknown columns, big)', 'allow_signup false', 'imported Carbon finishes setup on first sign-in'],
        integration: 'hosted',
        silicon_slt: false,
        accent: '#475569',
      },
    },
    {
      app_id: 'orbit-games',
      name: 'Orbit Games',
      description: 'Small multiplayer games you can embed anywhere.',
      owner: OWNERS.orbit,
      created_at: '2026-09-12T19:00:00.000Z',
      webhook: true,
      signin: {
        methods: { apple: true, email: false, phone: false, google: false },
        method_order: ['apple'],
        apple: { mode: 'byo', services_id: orbitApple.services_id, team_id: orbitApple.team_id, key_id: orbitApple.key_id, private_key: orbitApple.private_key_pem },
        required_fields: [],
        optional_fields: ['email'],
        allow_signup: true,
        remember_browser: true,
        branding: orbitBranding,
        copy: { title: 'Orbit Games', subtitle: 'Sign in to keep your progress.', terms_url: 'https://orbit-games.test/terms', privacy_url: 'https://orbit-games.test/privacy', support_email: 'support@orbit-games.test' },
      },
      testkit: {
        category: 'external (games)',
        purpose: 'Apple only with its own Apple Services ID (BYO), embedded as an iframe from an allowed origin, compact density.',
        exercises: ['Apple BYO (client_secret signed with orbit’s p8 key)', 'iframe embed via allowed_origins', 'compact density'],
        integration: 'iframe',
        silicon_slt: false,
        accent: '#312E81',
      },
    },
    {
      app_id: 'quill-docs',
      name: 'Quill Docs',
      description: 'Collaborative documents where Carbons and Silicons write together.',
      owner: OWNERS.quill,
      created_at: '2026-09-14T13:00:00.000Z',
      webhook: false,
      signin: {
        methods: { email: true, google: true, phone: false, apple: false },
        method_order: ['email', 'google'],
        google: { mode: 'managed', prompt: 'select_account' },
        required_fields: [],
        optional_fields: ['email'],
        allow_signup: true,
        remember_browser: true,
        branding: quillBranding,
        copy: { title: 'Sign in to Quill Docs', subtitle: 'Write together.', terms_url: 'https://quill-docs.test/terms', privacy_url: 'https://quill-docs.test/privacy', support_email: 'help@quill-docs.test' },
      },
      testkit: {
        category: 'external (docs)',
        purpose: 'Uses the SDK snippet and the OIDC id_token (scope openid); email is optional.',
        exercises: ['SDK snippet', 'OIDC: openid scope + nonce + id_token verification', 'optional email'],
        integration: 'sdk',
        authorize_params: { scope: 'openid email' },
        silicon_slt: false,
        accent: '#3B1D6E',
      },
    },
  ];
}

export function buildFakeApps(credentials: DevCredentials, base: string = FAKE_APP_SERVER): FakeAppsFile {
  const apps: SiliconAppsApp[] = drafts(credentials).map((draft) => {
    const secrets = SECRETS[draft.app_id];
    if (!secrets) throw new Error(`No fixed secret for fake app ${draft.app_id}.`);
    const logo = logoDataUri(draft.app_id, 'light');
    const logoDark = logoDataUri(draft.app_id, 'dark');
    const signin: SigninDefaults = {
      ...draft.signin,
      redirect_uris: [`${base}/${draft.app_id}/callback`],
      allowed_origins: [base],
      allowed_email_domains: draft.signin.allowed_email_domains ?? [],
    };
    if (signin.branding) signin.branding = { logo_url: logo, logo_dark_url: logoDark, ...signin.branding };
    return {
      app_id: draft.app_id,
      name: draft.name,
      description: draft.description,
      logo_url: logo,
      logo_dark_url: logoDark,
      homepage_url: `${base}/${draft.app_id}/`,
      owner_id: draft.owner.owner_id,
      owner_email: draft.owner.owner_email,
      secret: secrets.secret,
      status: 'active',
      created_at: draft.created_at,
      signin_defaults: signin,
      webhook_url: draft.webhook ? `${base}/${draft.app_id}/webhooks` : null,
      webhook_secret: draft.webhook ? secrets.webhook_secret : null,
      testkit: {
        ...draft.testkit,
        authorize_params: draft.testkit.authorize_params ?? {},
        proofs: draft.testkit.proofs ?? noProofs(),
        silicon_slt: draft.testkit.silicon_slt ?? false,
      },
    };
  });
  return {
    _comment:
      'Fake apps standing in for Silicon Apps (generated from testkit/src/fake-apps/definitions.ts by `pnpm -C testkit gen:apps`; do not edit by hand). Same shape as the POST /v1/internal/apps/sync body. Extra per-app fields for the testkit: webhook_url, webhook_secret, testkit. Development-only secrets.',
    version: 1,
    fake_app_server: base,
    apps,
  };
}
