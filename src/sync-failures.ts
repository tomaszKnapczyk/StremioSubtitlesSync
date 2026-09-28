import { TtlCache } from "./cache";

/**
 * Remembers which subtitle files could not be aligned to which video.
 *
 * Whether an alignment will hold cannot be known while the list is being built:
 * finding out means downloading the subtitle, which costs one of the few
 * OpenSubtitles downloads a day allows. Offering five of them and checking each
 * would spend a day's quota on a single film.
 *
 * So the answer is learned the expensive way once, when the player asks for the
 * file, and remembered. The entry that failed stops being offered, instead of
 * sitting in the subtitle menu doing nothing every time the film is opened.
 * Only a confident-alignment failure is recorded: a network error or a busy
 * host says nothing about whether these two belong together.
 */
const unalignable = new TtlCache<true>(6 * 60 * 60_000, 1000);

/** The video and the subtitle file together; neither alone decides this. */
export function unalignableKey(hintToken: string, fileId: number): string {
  return `${hintToken}:${fileId}`;
}

/**
 * The video itself, when its own subtitle track turned out to be unreadable or
 * too sparse to align against. That is a property of the file, not of any one
 * subtitle, so it rules out every offer built on the embedded route.
 */
export function noReferenceKey(hintToken: string): string {
  return `video:${hintToken}`;
}

export function markUnalignable(key: string): void {
  unalignable.set(key, true);
}

export function isUnalignable(key: string): boolean {
  return unalignable.get(key) === true;
}
