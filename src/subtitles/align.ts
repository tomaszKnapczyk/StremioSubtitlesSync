import type { Cue } from "./types";

/**
 * Reference-based subtitle alignment.
 *
 * Both subtitle files describe the same speech, so reduce each to a binary
 * "someone is talking" timeline and slide one over the other until the overlap
 * peaks. That offset is the sync fix. Same idea as ffsubsync, but the anchor is
 * a subtitle known to match the file rather than the audio track, so nothing
 * has to touch the video.
 */

/** Frame rate conversions that show up in the wild, as target/reference ratios. */
const FPS = { p23976: 24000 / 1001, p24: 24, p25: 25, p2997: 30000 / 1001, p30: 30 };
export const DEFAULT_RATIOS: number[] = [
  1,
  FPS.p23976 / FPS.p25,
  FPS.p25 / FPS.p23976,
  FPS.p23976 / FPS.p24,
  FPS.p24 / FPS.p23976,
  FPS.p24 / FPS.p25,
  FPS.p25 / FPS.p24,
  FPS.p2997 / FPS.p25,
  FPS.p25 / FPS.p2997,
];

export interface AlignOptions {
  /** Widest shift to consider, in either direction. */
  maxOffsetMs?: number;
  /** Bin width for the wide search. */
  coarseBinMs?: number;
  /** Bin width for the refinement pass. */
  fineBinMs?: number;
  /** How far around the coarse winner the refinement pass looks. */
  fineWindowMs?: number;
  /** Below this peak strength the coarse result is not trusted and ratios are tried. */
  ratioSearchBelow?: number;
  /** Below this overlap score the result is rejected and timings are left alone. */
  minConfidence?: number;
  /**
   * How far the best shift must stand out from the rest, in standard
   * deviations. Overlap alone is not enough to judge a match, because the
   * winner is the best of a thousand tried shifts and the best of a thousand
   * coin flips always looks impressive. This asks the different question: is
   * this peak unusual compared to every other shift we tried? A real match
   * towers over the field. A lucky one does not.
   */
  minPeakRatio?: number;
  /**
   * The second opinion's own bar, in standard deviations. Only consulted for a
   * match the overlap test turned down on its peak alone; see `onsetSearch`.
   */
  minOnsetPeakRatio?: number;
  /** How far apart the two methods' shifts may be and still count as agreeing. */
  onsetAgreementMs?: number;
  ratios?: number[];
}

export interface AlignResult {
  /** Milliseconds added to every cue (after scaling). */
  offsetMs: number;
  /** Factor every cue time was multiplied by. 1 means no frame rate fix. */
  ratio: number;
  /**
   * Of the reference's speech that the target covers, the share that lined up,
   * 0..1. Two unrelated subtitles still score roughly the target's own talking
   * density here, so treat anything near that as no match at all.
   */
  confidence: number;
  /** How many standard deviations the winning shift stood above the rest. */
  peakRatio: number;
  /**
   * Set when the overlap test alone would have refused this match and the
   * onset test vouched for it instead. Kept so the log can say which it was.
   */
  onsetPeakRatio?: number;
  /** False when the match was not convincing and the original timings were kept. */
  applied: boolean;
}

const DEFAULTS = {
  maxOffsetMs: 120_000,
  coarseBinMs: 200,
  fineBinMs: 20,
  fineWindowMs: 500,
  ratioSearchBelow: 8,
  minConfidence: 0.55,
  // Measured across the test suite: real matches land between 6.7 and 13,
  // deliberately mismatched films between 3.4 and 3.7. This sits between them.
  minPeakRatio: 5,
  // Measured on real files: a genuine match on dense dialogue stood 8.6 above
  // the field, an unrelated film 3.6. This sits between them, and the method
  // also has to agree with the overlap test on where the match is.
  minOnsetPeakRatio: 6,
  onsetAgreementMs: 1000,
  ratios: DEFAULT_RATIOS,
};

/** Dense 0/1 timeline: bin i is 1 when any cue covers it. */
function denseBins(cues: Cue[], binMs: number, ratio: number): Uint8Array {
  let maxEnd = 0;
  for (const c of cues) maxEnd = Math.max(maxEnd, c.end * ratio);
  const n = Math.floor(maxEnd / binMs) + 2;
  const bins = new Uint8Array(n);
  for (const c of cues) {
    const from = Math.max(0, Math.floor((c.start * ratio) / binMs));
    const to = Math.min(n - 1, Math.floor((Math.max(c.end, c.start + 1) * ratio - 1) / binMs));
    for (let i = from; i <= to; i++) bins[i] = 1;
  }
  return bins;
}

/** Indices of the set bins. Iterating these beats scanning the whole array. */
function setIndices(bins: Uint8Array): Int32Array {
  let count = 0;
  for (let i = 0; i < bins.length; i++) if (bins[i]) count++;
  const out = new Int32Array(count);
  let k = 0;
  for (let i = 0; i < bins.length; i++) if (bins[i]) out[k++] = i;
  return out;
}

interface Search {
  shiftBins: number;
  confidence: number;
  peakRatio: number;
}

/**
 * Slides the target over the reference and returns the best match.
 *
 * The score at each shift is a *rate*: of the reference's speech that the
 * shifted target actually covers, how much of it lined up. Measuring a rate
 * rather than a raw count is what makes this work on any length of film. A raw
 * count collapses as the target slides past the end of the reference, so on a
 * short film, where the search range is a large part of the runtime, the spread
 * of scores was dominated by how far things had slid rather than by how well
 * they matched. A rate stays comparable at every shift.
 *
 * Alongside the winner it collects the mean and spread of every shift tried, so
 * the caller can tell a real peak from the best of many random ones.
 */
function bestShift(
  refBins: Uint8Array,
  refPrefix: Int32Array,
  refOnCount: number,
  tgtOn: Int32Array,
  tgtLen: number,
  minShift: number,
  maxShift: number,
): Search {
  const refLen = refBins.length;
  // Shifts where barely any of the reference is covered produce wild rates off
  // a handful of bins, so they are not worth judging.
  const minSupport = Math.max(20, Math.floor(refOnCount * 0.3));

  let bestRate = 0;
  let bestShiftBins = 0;
  let sum = 0;
  let sumSquares = 0;
  let tried = 0;

  for (let shift = minShift; shift <= maxShift; shift++) {
    const lo = Math.max(0, shift);
    const hi = Math.min(refLen, shift + tgtLen);
    if (hi <= lo) continue;

    const support = refPrefix[hi]! - refPrefix[lo]!;
    if (support < minSupport) continue;

    let matched = 0;
    for (let j = 0; j < tgtOn.length; j++) {
      const idx = tgtOn[j]! + shift;
      if (idx >= 0 && idx < refLen && refBins[idx]) matched++;
    }

    const rate = matched / support;
    sum += rate;
    sumSquares += rate * rate;
    tried++;
    if (rate > bestRate) {
      bestRate = rate;
      bestShiftBins = shift;
    }
  }

  if (tried === 0) return { shiftBins: 0, confidence: 0, peakRatio: 0 };

  const mean = sum / tried;
  const variance = Math.max(0, sumSquares / tried - mean * mean);
  const deviation = Math.sqrt(variance);

  return {
    shiftBins: bestShiftBins,
    confidence: bestRate,
    peakRatio: deviation > 0 ? (bestRate - mean) / deviation : 0,
  };
}

function searchAtRatio(
  refCues: Cue[],
  tgtCues: Cue[],
  ratio: number,
  binMs: number,
  maxOffsetMs: number,
  centerMs = 0,
): { offsetMs: number; confidence: number; peakRatio: number } {
  const refBins = denseBins(refCues, binMs, 1);
  const tgtBins = denseBins(tgtCues, binMs, ratio);
  const tgtOn = setIndices(tgtBins);

  // Running total of reference speech bins, so the covered amount at any shift
  // is one subtraction rather than a second pass.
  const refPrefix = new Int32Array(refBins.length + 1);
  for (let i = 0; i < refBins.length; i++) {
    refPrefix[i + 1] = refPrefix[i]! + (refBins[i] ? 1 : 0);
  }
  const refOn = refPrefix[refBins.length]!;

  const span = Math.ceil(maxOffsetMs / binMs);
  const center = Math.round(centerMs / binMs);
  const found = bestShift(
    refBins,
    refPrefix,
    refOn,
    tgtOn,
    tgtBins.length,
    center - span,
    center + span,
  );
  return {
    offsetMs: found.shiftBins * binMs,
    confidence: found.confidence,
    peakRatio: found.peakRatio,
  };
}

/** Onset bins are finer than speech bins: a line's start is a point, not a span. */
const ONSET_BIN_MS = 100;
/** How close two starts must fall to count as the same moment: +/- 300ms. */
const ONSET_TOLERANCE_BINS = 3;

/**
 * The same search, but on where each line *starts* rather than on whether
 * anyone is talking.
 *
 * The overlap test has a blind spot. On dense dialogue a subtitle is on screen
 * most of the time -- measured at 81% and 90% for a sitcom episode -- so almost
 * every shift covers almost everything, the scores flatten out, and a genuine
 * match no longer towers over the field. The moment a line appears stays sparse
 * and distinctive even then, which is what this measures.
 *
 * It is only ever used as a second opinion on a match the overlap test turned
 * down for its peak alone, and it only vouches when it finds the same shift.
 */
function onsetSearch(
  refCues: Cue[],
  tgtCues: Cue[],
  ratio: number,
  maxOffsetMs: number,
): { offsetMs: number; peakRatio: number } {
  const none = { offsetMs: 0, peakRatio: 0 };
  if (refCues.length === 0 || tgtCues.length === 0) return none;

  const refOnsets = refCues.map((c) => Math.floor(c.start / ONSET_BIN_MS));
  let lastStart = 0;
  for (const c of tgtCues) lastStart = Math.max(lastStart, c.start * ratio);
  const span = Math.floor(lastStart / ONSET_BIN_MS) + ONSET_TOLERANCE_BINS + 2;

  // Each target start claims a small window, so a start that lands close
  // enough to a reference start counts as the same moment.
  const mask = new Uint8Array(span);
  for (const c of tgtCues) {
    const at = Math.floor((c.start * ratio) / ONSET_BIN_MS);
    for (let d = -ONSET_TOLERANCE_BINS; d <= ONSET_TOLERANCE_BINS; d++) {
      const i = at + d;
      if (i >= 0 && i < span) mask[i] = 1;
    }
  }

  const reach = Math.ceil(maxOffsetMs / ONSET_BIN_MS);
  // As in the overlap test, a shift that leaves most of the reference hanging
  // off either end is judged on too little to mean anything.
  const minSupport = refOnsets.length * 0.5;

  let best = 0;
  let bestShift = 0;
  let sum = 0;
  let sumSquares = 0;
  let tried = 0;

  for (let shift = -reach; shift <= reach; shift++) {
    let matched = 0;
    let support = 0;
    for (const onset of refOnsets) {
      const i = onset - shift;
      if (i < 0 || i >= span) continue;
      support++;
      if (mask[i]) matched++;
    }
    if (support < minSupport) continue;

    const rate = matched / support;
    sum += rate;
    sumSquares += rate * rate;
    tried++;
    if (rate > best) {
      best = rate;
      bestShift = shift;
    }
  }

  if (tried === 0) return none;
  const mean = sum / tried;
  const deviation = Math.sqrt(Math.max(0, sumSquares / tried - mean * mean));
  return {
    // Same convention as the overlap test: added to the target's times.
    offsetMs: bestShift * ONSET_BIN_MS,
    peakRatio: deviation > 0 ? (best - mean) / deviation : 0,
  };
}

/** Finds the shift (and frame rate fix) that maps `target` onto `reference`. */
export function align(reference: Cue[], target: Cue[], options: AlignOptions = {}): AlignResult {
  const opt = { ...DEFAULTS, ...options };
  const none: AlignResult = { offsetMs: 0, ratio: 1, confidence: 0, peakRatio: 0, applied: false };
  if (reference.length < 5 || target.length < 5) return none;

  // Most files just need a shift, so try that alone before paying for a ratio sweep.
  let best = { ratio: 1, ...searchAtRatio(reference, target, 1, opt.coarseBinMs, opt.maxOffsetMs) };

  if (best.peakRatio < opt.ratioSearchBelow) {
    for (const ratio of opt.ratios) {
      if (ratio === 1) continue;
      const got = searchAtRatio(reference, target, ratio, opt.coarseBinMs, opt.maxOffsetMs);
      // Compare peaks, not raw overlap: a stretched target covers a slightly
      // different number of bins, which nudges overlap but not how far the
      // winning shift stands out.
      if (got.peakRatio > best.peakRatio) best = { ratio, ...got };
    }
  }

  // A match turned down for its peak alone, with the overlap itself convincing,
  // is the signature of dense dialogue rather than of a wrong film. Ask the
  // onset test, and take its word only when it both stands out clearly and
  // lands on the same shift. An unrelated film would have to pass three
  // independent checks by chance.
  let onsetPeakRatio: number | undefined;
  if (best.confidence >= opt.minConfidence && best.peakRatio < opt.minPeakRatio) {
    const onsets = onsetSearch(reference, target, best.ratio, opt.maxOffsetMs);
    const agrees = Math.abs(onsets.offsetMs - best.offsetMs) <= opt.onsetAgreementMs;
    if (onsets.peakRatio >= opt.minOnsetPeakRatio && agrees) {
      onsetPeakRatio = onsets.peakRatio;
    }
  }

  if (
    best.confidence < opt.minConfidence ||
    (best.peakRatio < opt.minPeakRatio && onsetPeakRatio === undefined)
  ) {
    // Report what was actually measured. Returning the zeroed sentinel here hid
    // the reason for every rejection behind "overlap 0.00, peak 0.0", which
    // reads like a broken comparison rather than a considered refusal.
    return {
      offsetMs: 0,
      ratio: 1,
      confidence: best.confidence,
      peakRatio: best.peakRatio,
      applied: false,
    };
  }

  // Narrow pass around the winner, at a bin size the player can actually notice.
  const fine = searchAtRatio(
    reference,
    target,
    best.ratio,
    opt.fineBinMs,
    opt.fineWindowMs,
    best.offsetMs,
  );

  return {
    offsetMs: fine.offsetMs,
    ratio: best.ratio,
    confidence: Math.max(fine.confidence, best.confidence),
    // The refinement pass only looks at a handful of nearby shifts, so its own
    // spread means nothing. The wide search is what judged the match.
    peakRatio: best.peakRatio,
    ...(onsetPeakRatio !== undefined ? { onsetPeakRatio } : {}),
    applied: true,
  };
}

/** Rewrites cue times with the result of `align`. Cues pushed before zero are dropped. */
export function applyAlignment(cues: Cue[], result: AlignResult): Cue[] {
  if (!result.applied) return cues;
  const out: Cue[] = [];
  for (const c of cues) {
    const start = Math.round(c.start * result.ratio + result.offsetMs);
    const end = Math.round(c.end * result.ratio + result.offsetMs);
    if (end <= 0) continue;
    out.push({ start: Math.max(0, start), end, text: c.text });
  }
  return out;
}
