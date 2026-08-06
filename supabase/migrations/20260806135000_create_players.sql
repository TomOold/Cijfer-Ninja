create table if not exists public.players (
  name_key text primary key,
  display_name text not null check (char_length(display_name) between 1 and 20),
  pin_hash text not null check (char_length(pin_hash) = 64),
  data jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists players_updated_at_idx
  on public.players (updated_at desc);

alter table public.players enable row level security;

revoke all on table public.players from anon, authenticated;
grant select, insert, update on table public.players to service_role;

comment on table public.players is
  'Server-only Nummers Ninja profiles. PINs are stored as peppered HMAC hashes.';
