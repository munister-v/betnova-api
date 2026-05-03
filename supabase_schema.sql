-- ============================================================
-- USERS
-- ============================================================
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  wallet_address text unique,
  username text not null,
  avatar_url text,
  balance numeric(20, 8) not null default 0,
  xp integer not null default 0,
  level integer not null default 1,
  total_wagered numeric(20, 8) not null default 0,
  server_seed text,
  server_seed_hash text,
  client_seed text,
  nonce integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================
-- TRANSACTIONS
-- ============================================================
create table if not exists transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  type text not null check (type in ('deposit','withdrawal','bet','win','refund')),
  amount numeric(20, 8) not null,
  asset text,
  address text,
  status text not null default 'pending' check (status in ('pending','completed','failed')),
  reference text unique,
  metadata jsonb,
  created_at timestamptz not null default now()
);
create index if not exists transactions_user_id_idx on transactions(user_id);

-- ============================================================
-- PAYMENT WALLETS
-- ============================================================
create table if not exists payment_wallets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  asset text not null,
  network text not null,
  address text not null,
  created_at timestamptz not null default now()
);

-- ============================================================
-- GAME HISTORY (unified)
-- ============================================================
create table if not exists game_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  game_type text not null,
  bet_amount numeric(20, 8) not null,
  profit numeric(20, 8) not null default 0,
  wagered numeric(20, 8) not null,
  multiplier numeric(10, 4),
  metadata jsonb,
  created_at timestamptz not null default now()
);
create index if not exists game_history_user_id_idx on game_history(user_id);

-- ============================================================
-- CRASH
-- ============================================================
create table if not exists crash_games (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'waiting' check (status in ('waiting','running','crashed')),
  crash_multiplier numeric(10, 2),
  multiplier numeric(10, 2) default 1.0,
  server_seed text,
  server_seed_hash text not null,
  hash text,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists crash_bets (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references crash_games(id),
  user_id uuid not null references users(id),
  bet_amount numeric(20, 8) not null,
  auto_cashout numeric(10, 2),
  cashout_multiplier numeric(10, 2),
  profit numeric(20, 8),
  status text not null default 'active' check (status in ('active','cashed_out','lost')),
  created_at timestamptz not null default now()
);

-- ============================================================
-- COINFLIP
-- ============================================================
create table if not exists coinflip_games (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references users(id),
  joiner_id uuid references users(id),
  winner_id uuid references users(id),
  bet_amount numeric(20, 8) not null,
  creator_side text not null check (creator_side in ('heads','tails')),
  result_side text check (result_side in ('heads','tails')),
  status text not null default 'waiting' check (status in ('waiting','completed','cancelled')),
  server_seed text,
  server_seed_hash text,
  ended_at timestamptz,
  created_at timestamptz not null default now()
);

-- ============================================================
-- ROULETTE
-- ============================================================
create table if not exists roulette_games (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'betting' check (status in ('betting','spinning','completed')),
  result_number integer,
  started_at timestamptz,
  betting_closes_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists roulette_bets (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references roulette_games(id),
  user_id uuid not null references users(id),
  bet_amount numeric(20, 8) not null,
  bet_type text not null,
  profit numeric(20, 8),
  status text not null default 'pending' check (status in ('pending','won','lost')),
  created_at timestamptz not null default now()
);

-- ============================================================
-- MINE (minesweeper)
-- ============================================================
create table if not exists mine_games (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  bet_amount numeric(20, 8) not null,
  mine_count integer not null,
  mine_positions integer[] not null,
  revealed_positions integer[] not null default '{}',
  current_multiplier numeric(10, 4) default 1.0,
  status text not null default 'active' check (status in ('active','won','lost','cancelled')),
  profit numeric(20, 8),
  server_seed text,
  server_seed_hash text,
  client_seed text,
  nonce integer,
  created_at timestamptz not null default now()
);
create index if not exists mine_games_user_id_idx on mine_games(user_id);

-- ============================================================
-- CHAT
-- ============================================================
create table if not exists chat_messages (
  id bigint primary key generated always as identity,
  user_id uuid not null references users(id),
  content text not null,
  created_at timestamptz not null default now()
);
create index if not exists chat_messages_created_at_idx on chat_messages(created_at desc);

-- ============================================================
-- XP / LEVELS
-- ============================================================
create table if not exists level_requirements (
  level integer primary key,
  xp_required integer not null,
  rewards jsonb
);

create table if not exists achievements (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  icon text,
  xp_reward integer default 0
);

create table if not exists user_achievements (
  user_id uuid not null references users(id),
  achievement_id uuid not null references achievements(id),
  unlocked_at timestamptz not null default now(),
  primary key (user_id, achievement_id)
);

-- ============================================================
-- SEED LEVEL REQUIREMENTS
-- ============================================================
insert into level_requirements (level, xp_required) values
  (1, 0),(2, 100),(3, 250),(4, 500),(5, 1000),
  (10, 5000),(20, 20000),(30, 60000),(50, 200000),(100, 1000000)
on conflict do nothing;

-- ============================================================
-- REFERRALS
-- ============================================================
create table if not exists referral_codes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users(id),
  code text unique not null,
  uses integer not null default 0,
  earned numeric(20, 8) not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists referral_codes_owner_idx on referral_codes(owner_id);

create table if not exists referral_uses (
  id uuid primary key default gen_random_uuid(),
  referrer_id uuid not null references users(id),
  referred_id uuid not null references users(id),
  code text not null,
  commission numeric(20, 8) not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists referral_uses_referrer_idx on referral_uses(referrer_id);
