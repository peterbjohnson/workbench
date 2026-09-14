/**
 * The one way a run ends that is worth waiting out rather than failing.
 *
 * "You've hit your session limit · resets 10:30pm (Europe/London)" is not a fact
 * about the ticket and not a fact about the work: it is the service saying come
 * back later, and it says exactly when. Read here, it becomes a time; everything
 * that follows — parking the run with its conversation, starting nothing until
 * then, carrying on at that moment — is the ordinary interruption machinery.
 *
 * Recognised by its text, like `isCredentialRejection`, because that is all a
 * thrown ending gives us.
 */

/** The ending this reads, and nothing else. */
const IS_LIMIT = /session limit/i;

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
 */
const GRACE = 2;

/**
 * When the service says this run may carry on, or undefined when the text is not
 * a session limit or does not say. Undefined is the old behaviour — the run fails
 * — so anything unreadable costs nothing new.
 */
export function readSessionLimit(text: string, now: Date): Date | undefined {
  if (!IS_LIMIT.test(text)) return undefined;

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
  // tomorrow — except within the grace, where it means now: reading "resets 10:30pm"
  // at 22:30 is the ordinary case, and turning it into a day would hold the whole
  // board for one.
  const ahead = (hour * 60 + minute - here + 1440) % 1440;
  const wait = ahead === 0 || ahead >= 1440 - GRACE ? 0 : ahead;
  return new Date(
    now.getTime() + wait * 60_000 - (now.getSeconds() * 1000 + now.getMilliseconds()),
  );
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
