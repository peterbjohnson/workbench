/**
 * The one way a run ends that is worth waiting out rather than failing.
 *
 * "You've hit your session limit · resets 10:30pm (Europe/London)" is not a fact
 * about the ticket and not a fact about the work: it is the service saying come
 * back later, and it says exactly when. Read here, it becomes a time; everything
 * that follows — parking the run with its conversation, starting nothing until
 * then, carrying on at that moment — is the ordinary interruption machinery.
 *
 * Recognised by its text, like `isCredentialRejection`, and also by what the SDK
 * hung on the throw — a 429, a rate-limit type — because the prose is the service's
 * to reword and the shape is not. The *time*, though, is text and only text: no
 * status code says when to come back, so a widened gate buys a wider recognition
 * of the ending, never a wider reading of it.
 */

/** The ending this reads in the prose. */
const IS_LIMIT = /session limit/i;

/** And in the shape: what the SDK calls a throttle, whatever words came with it. */
const LIMIT_TYPE = /rate.?limit|usage.?limit|session.?limit/i;

/** When it says work resumes: `resets 10:30pm`, `resets 3pm`, `resets 22:30`. */
const RESETS = /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i;

/** The zone that time is in, as an IANA name in brackets. */
const ZONE = /\(([A-Za-z]+\/[A-Za-z0-9_+\-/]+)\)/;

/**
 * How far behind the stated time still counts as it, in minutes. The message is read
 * when the run dies, which is a moment or two after the service decided it — and a
 * message re-read at 22:32 saying "resets 10:30pm" means come back now, not in 23
 * hours and 58 minutes. Small, because further behind than this and the reset really
 * has gone by: an overnight run that finds a stale message must wait for the next one.
 *
 * A read inside the grace comes back at the *end* of it — the stated minute plus
 * `GRACE + 1` — and never at the moment of reading. Two things follow, and both matter.
 * The instant is always strictly in the future, so a ticket is never parked until a
 * time already gone and carried on again on the tick that parked it. And every read of
 * the same message within the grace names the same instant, so a service still refusing
 * when the run resumes there reads the message outside the grace and rolls to the next
 * day: one retry, not a loop running at whatever speed the API answers.
 */
const GRACE = 2;

/**
 * Whether a thrown object is one the service throttled, by its structure rather than
 * its words. Everything here is optional and nothing is trusted: a thrown string, a
 * null, a `status` that is the string '429' rather than the number, all say no.
 */
function limitShaped(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const it = error as Record<string, unknown>;
  const response = typeof it.response === 'object' && it.response !== null ? it.response : {};
  const status = [it.status, it.statusCode, (response as Record<string, unknown>).status];
  if (status.includes(429)) return true;

  const nested = typeof it.error === 'object' && it.error !== null ? it.error : {};
  const named = [it.type, it.code, (nested as Record<string, unknown>).type];
  return named.some((name) => typeof name === 'string' && LIMIT_TYPE.test(name));
}

/**
 * Whether this ending is the service saying come back later — read from both halves
 * of what a throw carries, so a reworded message with a 429 on it is still known.
 * Exported because the caller announces the ones it could name no time from, and must
 * ask the same question this does to know which those are.
 */
export function looksLikeSessionLimit(text: string, error?: unknown): boolean {
  return IS_LIMIT.test(text) || limitShaped(error);
}

/**
 * When the service says this run may carry on, or undefined when the ending is not
 * a session limit or the text does not say when. Undefined is the old behaviour — the
 * run fails — so anything unreadable costs nothing new.
 */
export function readSessionLimit(text: string, now: Date, error?: unknown): Date | undefined {
  if (!looksLikeSessionLimit(text, error)) return undefined;

  const at = RESETS.exec(text);
  if (at === null) return undefined;

  const suffix = at[3]?.toLowerCase();
  let hour = Number(at[1]);
  if (suffix === 'pm' && hour !== 12) hour += 12;
  if (suffix === 'am' && hour === 12) hour = 0;
  const minute = Number(at[2] ?? 0);
  if (hour > 23 || minute > 59) return undefined;

  const here = wallMinutes(now, ZONE.exec(text)?.[1]);
  if (here === undefined) return undefined;

  // The difference between two wall clocks in the same zone is real time, whatever
  // zone this machine is in — so the waiting is done in milliseconds and no date
  // arithmetic happens anywhere we are not standing. Already gone today means
  // tomorrow — except within the grace, where it means the end of the grace: reading
  // "resets 10:30pm" at 22:30 is the ordinary case, and turning it into a day would
  // hold the whole board for one.
  const ahead = (hour * 60 + minute - here + 1440) % 1440;
  const inGrace = ahead === 0 || ahead >= 1440 - GRACE;
  const behind = ahead === 0 ? 0 : 1440 - ahead;
  const startOfMinute = now.getTime() - (now.getSeconds() * 1000 + now.getMilliseconds());
  return inGrace
    ? new Date(startOfMinute - behind * 60_000 + (GRACE + 1) * 60_000)
    : new Date(startOfMinute + ahead * 60_000);
}

/** What the clock reads in `zone`, in minutes — the machine's own when none was named. */
function wallMinutes(now: Date, zone?: string): number | undefined {
  try {
    const [hour, minute] = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .format(now)
      .split(':')
      .map(Number);
    if (hour === undefined || minute === undefined || Number.isNaN(hour) || Number.isNaN(minute)) {
      return undefined;
    }
    return hour * 60 + minute;
  } catch {
    // A zone this machine has never heard of. Nothing readable, so nothing waited for.
    return undefined;
  }
}
