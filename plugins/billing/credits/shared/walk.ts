/**
 * The balance: credits and what was spent, walked day by day (UTC), so each
 * day's spending comes out of what was there that day and what lapses, lapses.
 * Pure: no store, no clock.
 *
 * Each day: what's expired goes, what was granted comes (paying any debt
 * first), then what was spent is taken: what expires soonest first, then, among
 * those alike, plan credits, the trial, gifts, and last what was bought.
 * Spending beyond the credits is debt, which the next grant pays.
 */
export type Grant = {
  _id: string;
  kind: string;
  amount: number;
  at: string;
  expires?: string;
};

export type Bucket = { id: string; kind: string; amount: number; left: number; expires?: string };

export type Walked = {
  /** Credits left less any debt: negative when more was spent than there was. */
  balance: number;
  /** The credits still there, in the order they'll be spent. */
  buckets: Bucket[];
  debt: number;
  /** Credits that lapsed unspent. */
  expired: number;
};

const RANK: Record<string, number> = {
  plan: 0,
  trial: 1,
  gift: 2,
  referral: 3,
  waived: 4,
  adjustment: 5,
  purchase: 6,
};

/** USD to a millionth of a cent, as the ledger keeps it. */
const round = (usd: number) => Math.round(usd * 1e8) / 1e8;

const order = (a: Bucket, b: Bucket) =>
  (a.expires ?? "9999").localeCompare(b.expires ?? "9999") ||
  (RANK[a.kind] ?? 9) - (RANK[b.kind] ?? 9) || a.id.localeCompare(b.id);

export function walk(grants: Grant[], spent: Record<string, number>, today: string): Walked {
  const byDay = new Map<string, Grant[]>();
  for (const grant of grants) {
    const day = grant.at.slice(0, 10);
    byDay.set(day, [...byDay.get(day) ?? [], grant]);
  }
  const days = [...new Set([...byDay.keys(), ...Object.keys(spent), today])]
    .filter((day) => day <= today).sort();
  let buckets: Bucket[] = [];
  let debt = 0;
  let expired = 0;
  const take = (amount: number) => {
    let owed = amount;
    for (const bucket of buckets) {
      if (owed <= 0) break;
      const taken = Math.min(bucket.left, owed);
      bucket.left -= taken;
      owed -= taken;
    }
    debt += owed;
    buckets = buckets.filter((bucket) => bucket.left > 1e-9);
  };
  for (const day of days) {
    buckets = buckets.filter((bucket) => {
      if (bucket.expires && bucket.expires <= day) {
        expired += bucket.left;
        return false;
      }
      return true;
    });
    let out = spent[day] ?? 0;
    for (const grant of byDay.get(day) ?? []) {
      if (grant.amount < 0) {
        out -= grant.amount;
        continue;
      }
      if (grant.expires && grant.expires <= day) continue;
      const paid = Math.min(debt, grant.amount);
      debt -= paid;
      if (grant.amount > paid) {
        buckets.push({
          id: grant._id,
          kind: grant.kind,
          amount: grant.amount,
          left: grant.amount - paid,
          ...(grant.expires ? { expires: grant.expires } : {}),
        });
      }
    }
    buckets.sort(order);
    if (out >= 0) take(out);
    else {
      // More came back than went (a correction): it pays debt, then it's credit like any other.
      const back = -out;
      const paid = Math.min(debt, back);
      debt -= paid;
      if (back > paid) {
        buckets.push({
          id: `back:${day}`,
          kind: "adjustment",
          amount: back - paid,
          left: back - paid,
        });
        buckets.sort(order);
      }
    }
  }
  const left = buckets.reduce((sum, bucket) => sum + bucket.left, 0);
  return {
    balance: round(left - debt),
    buckets: buckets.map((bucket) => ({
      ...bucket,
      left: round(bucket.left),
      amount: round(bucket.amount),
    })),
    debt: round(debt),
    expired: round(expired),
  };
}

const dayIn = (year: number, month: number, day: number) => {
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, last))).toISOString().slice(0, 10);
};

/**
 * The period `now` falls in, for an `anchor`: from its day of the month to the
 * same day the next (a shorter month's last, where it has none).
 */
export function periodOf(anchor: string, now: string): { start: string; end: string } {
  const day = new Date(anchor).getUTCDate();
  const at = new Date(now);
  const [y, m] = [at.getUTCFullYear(), at.getUTCMonth()];
  const here = dayIn(y, m, day);
  return now.slice(0, 10) >= here
    ? { start: here, end: dayIn(y, m + 1, day) }
    : { start: dayIn(y, m - 1, day), end: here };
}

/** The first day of the month `now` falls in, and of the next. */
export function monthOf(now: string): { start: string; end: string } {
  const at = new Date(now);
  const [y, m] = [at.getUTCFullYear(), at.getUTCMonth()];
  return { start: dayIn(y, m, 1), end: dayIn(y, m + 1, 1) };
}
