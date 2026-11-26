// Coins, XP and rewards. All economy writes execute inside SQLite BEGIN IMMEDIATE
// transactions with optional idempotency keys to guarantee zero double-spend under heavy concurrency.
import { randomInt } from 'node:crypto';
import { GameError } from './game/engine.js';

export const SPIN_COOLDOWN_MS = Number(process.env.SPIN_COOLDOWN_MS ?? 24 * 3600_000);
export const SPIN_DOUBLE_WINDOW_MS = 10 * 60_000;
export const AD_REWARD = 50;
export const AD_REWARDS_PER_DAY = 10;
export const REFERRAL_BONUS = 200;
export const XP_WIN = 30;
export const XP_LOSS = 10;
export const BOT_WIN_COINS = 20;

export const DAILY_REWARDS = [50, 75, 100, 150, 200, 300, 500];

export const QUICK_CHATS = [
  'Best of luck!',
  'Nice move!',
  'Oops!',
  'Play fast!',
  'Please don’t kill!',
  'Good game!',
  'Haha!',
  'Well played!',
];

export const STAKES = [0, 100, 500, 1000, 5000];
export const TABLE_FEE = 0.1;

export const SPIN_PRIZES = [
  { coins: 50, weight: 26 },
  { coins: 100, weight: 22 },
  { coins: 250, weight: 16 },
  { coins: 75, weight: 14 },
  { coins: 500, weight: 9 },
  { coins: 150, weight: 8 },
  { coins: 1000, weight: 4 },
  { coins: 2500, weight: 1 },
];

export function levelFor(xp) {
  let level = 1;
  let need = 100;
  let left = xp;
  while (left >= need) {
    left -= need;
    level++;
    need += 50;
  }
  return { level, xpInLevel: left, xpForNext: need };
}

export function today(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function yesterday(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  return d.toISOString().slice(0, 10);
}

export function dailyStatus(u, now = new Date()) {
  const curDay = today(now);
  const prevDay = yesterday(now);
  const claimedToday = u.last_daily_day === curDay;
  let streak = u.daily_streak || 0;
  if (!claimedToday && u.last_daily_day !== prevDay) {
    streak = 0;
  }
  const nextDay = claimedToday ? streak : (streak % DAILY_REWARDS.length) + 1;
  return {
    claimedToday,
    streak,
    nextDay,
    nextCoins: DAILY_REWARDS[nextDay - 1],
    rewards: DAILY_REWARDS,
  };
}

export function publicProfile(u, store, now = Date.now()) {
  if (!u) return null;
  const lvl = levelFor(u.xp);
  const daily = dailyStatus(u, new Date(now));
  const canDoubleSpin = !!(
    u.last_spin_coins > 0 &&
    !u.last_spin_doubled &&
    u.last_spin &&
    now - u.last_spin < SPIN_DOUBLE_WINDOW_MS
  );
  return {
    userId: u.user_id,
    name: u.name,
    avatar: u.avatar,
    gender: u.gender,
    email: u.email,
    coins: u.coins,
    xp: u.xp,
    ...lvl,
    wins: u.wins,
    losses: u.losses,
    referral: u.referral,
    referredBy: u.referred_by,
    nextSpinAt: u.last_spin ? u.last_spin + SPIN_COOLDOWN_MS : 0,
    canDoubleSpin,
    lastSpinCoins: canDoubleSpin ? u.last_spin_coins : 0,
    dailyClaimed: daily.claimedToday,
    dailyStreak: daily.streak,
    dailyNextDay: daily.nextDay,
    dailyNextCoins: daily.nextCoins,
    adsLeftToday: Math.max(0, AD_REWARDS_PER_DAY - (u.ad_day === today(new Date(now)) ? u.ad_count : 0)),
    rank: store?.rankOf(u.player_id, 'all')?.rank ?? null,
  };
}

export function spin(store, playerId, now = Date.now(), idempotencyKey = null, cache = null) {
  const res = store.runIdempotent(idempotencyKey, playerId, 'spin', () => {
    const u = store.get(playerId);
    if (!u) throw new GameError('NO_USER', 'Unknown player');
    if (u.last_spin && now - u.last_spin < SPIN_COOLDOWN_MS) {
      throw new GameError('SPIN_WAIT', 'Come back later for your next spin');
    }
    const total = SPIN_PRIZES.reduce((a, p) => a + p.weight, 0);
    let roll = randomInt(total);
    let index = 0;
    for (; index < SPIN_PRIZES.length; index++) {
      roll -= SPIN_PRIZES[index].weight;
      if (roll < 0) break;
    }
    const prize = SPIN_PRIZES[index].coins;
    store.setSpin(playerId, now, prize);
    store.addCoins(playerId, prize, 'spin', idempotencyKey ?? '');
    return { index, coins: prize, canDouble: true };
  });
  cache?.delPrefix('lb:');
  return res;
}

export function spinDouble(store, playerId, now = Date.now(), idempotencyKey = null, cache = null) {
  const res = store.runIdempotent(idempotencyKey, playerId, 'spin_double', () => {
    const u = store.get(playerId);
    if (!u) throw new GameError('NO_USER', 'Unknown player');
    if (!u.last_spin_coins || u.last_spin_doubled || !u.last_spin || now - u.last_spin >= SPIN_DOUBLE_WINDOW_MS) {
      throw new GameError('NO_SPIN_DOUBLE', 'No recent spin prize available to double');
    }
    const bonus = u.last_spin_coins;
    store.markSpinDoubled(playerId);
    store.addCoins(playerId, bonus, 'spin_double', idempotencyKey ?? '');
    return { bonus, total: bonus * 2 };
  });
  cache?.delPrefix('lb:');
  return res;
}

export function claimDaily(store, playerId, now = new Date(), idempotencyKey = null, cache = null) {
  const res = store.runIdempotent(idempotencyKey, playerId, 'daily', () => {
    const u = store.get(playerId);
    if (!u) throw new GameError('NO_USER', 'Unknown player');
    const status = dailyStatus(u, now);
    if (status.claimedToday) throw new GameError('DAILY_CLAIMED', 'Today’s reward is already claimed');
    const day = status.nextDay;
    const coins = DAILY_REWARDS[day - 1];
    store.setDaily(playerId, day, today(now));
    store.addCoins(playerId, coins, 'daily', idempotencyKey ?? '');
    return { day, coins };
  });
  cache?.delPrefix('lb:');
  return res;
}

export function adReward(store, playerId, idempotencyKey = null, cache = null) {
  const res = store.runIdempotent(idempotencyKey, playerId, 'ad', () => {
    const r = store.bumpAdCountAtomic(playerId, today(), AD_REWARDS_PER_DAY);
    if (r.error === 'NO_USER') throw new GameError('NO_USER', 'Unknown player');
    if (r.error === 'AD_TOO_FAST') throw new GameError('AD_TOO_FAST', 'Please wait a moment between videos');
    if (r.error === 'AD_LIMIT') throw new GameError('AD_LIMIT', 'Daily free coins used up — come back tomorrow');
    store.addCoins(playerId, AD_REWARD, 'ad', idempotencyKey ?? '');
    return { coins: AD_REWARD, left: AD_REWARDS_PER_DAY - r.count };
  });
  cache?.delPrefix('lb:');
  return res;
}

export function applyReferral(store, playerId, code, idempotencyKey = null, cache = null) {
  const res = store.runIdempotent(idempotencyKey, playerId, 'referral', () => {
    const me = store.get(playerId);
    if (!me) throw new GameError('NO_USER', 'Unknown player');
    if (me.referred_by) throw new GameError('REF_USED', 'You already used a referral code');
    const friend = store.byReferral(code);
    if (!friend) throw new GameError('REF_BAD', 'Code not found');
    if (friend.player_id === playerId) throw new GameError('REF_SELF', 'That is your own code');
    store.setReferredBy(playerId, friend.referral);
    store.addCoins(playerId, REFERRAL_BONUS, 'referral', friend.referral);
    store.addCoins(friend.player_id, REFERRAL_BONUS, 'referral', me.referral);
    return { coins: REFERRAL_BONUS };
  });
  cache?.delPrefix('lb:');
  return res;
}

export function potFor(stake, seats) {
  return Math.floor(stake * seats * (1 - TABLE_FEE));
}
