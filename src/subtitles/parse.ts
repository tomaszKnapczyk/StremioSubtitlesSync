import type { Cue, SubtitleFormat } from "./types";

/** Matches h:mm:ss,mmm / h:mm:ss.mmm and the hour-less mm:ss.mmm of WebVTT. */
const TIME_RE = /(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})/;

/** {start}{end}, counted in frames. Meaningless without a frame rate. */
const MICRODVD_LINE = /^\{(\d+)\}\{(\d*)\}(.*)$/;
/** [start][end], in tenths of a second. */
const MPL2_LINE = /^\[(\d+)\]\[(\d*)\](.*)$/;
/** hh:mm:ss followed by the line. No end time is given at all. */
const TMPLAYER_LINE = /^(\d{1,2}):([0-5]\d):([0-5]\d)[:=](.*)$/;

function parseTime(raw: string): number | null {
  const m = TIME_RE.exec(raw);
  if (!m) return null;
  const [, h, mm, ss, frac] = m;
  // "12" means 120ms, not 12ms, so pad the fraction out to milliseconds.
  const ms = Number(frac!.padEnd(3, "0"));
  return Number(h ?? 0) * 3600000 + Number(mm) * 60000 + Number(ss) * 1000 + ms;
}

export function detectFormat(text: string): SubtitleFormat {
  const head = text.slice(0, 2000);
  if (/^﻿?WEBVTT/.test(head)) return "vtt";
  if (/\[Script Info\]/i.test(head) || /^\s*Dialogue:/m.test(head)) return "ass";

  // The Polish services serve these three far more often than SRT. Each is
  // known by the shape of its first real line, so a blank line or a comment at
  // the top does not throw the guess off.
  for (const line of head.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (MICRODVD_LINE.test(trimmed)) return "microdvd";
    if (MPL2_LINE.test(trimmed)) return "mpl2";
    if (TMPLAYER_LINE.test(trimmed)) return "tmplayer";
    break;
  }
  return "srt";
}

/**
 * SRT and WebVTT differ only in the separator and a header, so one scanner
 * handles both: find every line holding "-->", then take the lines under it.
 */
function parseCueList(text: string): Cue[] {
  const lines = text.split("\n");
  const cues: Cue[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.includes("-->")) continue;

    const [left, right] = line.split("-->");
    const start = parseTime(left ?? "");
    const end = parseTime(right ?? "");
    if (start === null || end === null) continue;

    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length) {
      const next = lines[j]!;
      if (next.trim() === "" || next.includes("-->")) break;
      body.push(next);
      j++;
    }
    // Stopping on a "-->" means the line we just took was the next cue's
    // index number, not text. Give it back.
    if (j < lines.length && lines[j]!.includes("-->") && body.length > 0) {
      body.pop();
    }

    cues.push({ start, end: Math.max(end, start), text: body.join("\n").trim() });
    i = j - 1;
  }
  return cues;
}

function parseAss(text: string): Cue[] {
  const lines = text.split("\n");
  const cues: Cue[] = [];
  // Field order is declared per file by the Format: line in [Events].
  let startIdx = 1;
  let endIdx = 2;
  let textIdx = 9;

  for (const raw of lines) {
    const line = raw.trim();
    if (/^Format:/i.test(line)) {
      const fields = line.slice(line.indexOf(":") + 1).split(",").map((f) => f.trim().toLowerCase());
      if (fields.includes("start") && fields.includes("end")) {
        startIdx = fields.indexOf("start");
        endIdx = fields.indexOf("end");
        const t = fields.indexOf("text");
        textIdx = t >= 0 ? t : fields.length - 1;
      }
      continue;
    }
    if (!/^Dialogue:/i.test(line)) continue;

    const rest = line.slice(line.indexOf(":") + 1);
    // Text is the last field and may itself contain commas, so cap the split.
    const parts = rest.split(",");
    const head = parts.slice(0, textIdx);
    const body = parts.slice(textIdx).join(",");

    const start = parseTime(head[startIdx] ?? "");
    const end = parseTime(head[endIdx] ?? "");
    if (start === null || end === null) continue;

    const plain = body
      .replace(/\{[^}]*\}/g, "") // drop override blocks
      // ASS writes a line break as a literal backslash followed by N or n.
      .replace(/\\N|\\n/g, "\n")
      .trim();
    cues.push({ start, end: Math.max(end, start), text: plain });
  }
  return cues;
}

/**
 * Strips the inline styling these formats carry: {y:i} and friends in MicroDVD,
 * a leading slash for italics in MPL2. A pipe is their line break.
 */
function cleanText(raw: string, format: SubtitleFormat): string {
  const text = format === "microdvd" ? raw.replace(/\{[a-zA-Z]:[^}]*\}/g, "") : raw;
  return text
    .split("|")
    .map((part) => (format === "mpl2" ? part.replace(/^\s*\//, "") : part).trim())
    .filter((part) => part !== "")
    .join("\n")
    .trim();
}

/**
 * MicroDVD counts frames, so without the right frame rate every timing is out
 * by a constant factor. In order of trust: the rate the file states itself in
 * the conventional {1}{1}<rate> first line, then whatever the source said, then
 * the usual film rate. A wrong guess is recoverable, because the aligner
 * searches frame-rate ratios, but only when there is a reference to align to.
 */
const DEFAULT_FPS = 23.976;

function isFpsDeclaration(match: RegExpExecArray): boolean {
  return match[1] === "1" && match[2] === "1" && /^[\d.,]+$/.test((match[3] ?? "").trim());
}

function microDvdFps(text: string, supplied: number | undefined): number {
  for (const line of text.split("\n")) {
    const match = MICRODVD_LINE.exec(line.trim());
    if (!match) continue;
    if (isFpsDeclaration(match)) {
      const declared = Number((match[3] ?? "").trim().replace(",", "."));
      if (Number.isFinite(declared) && declared > 0) return declared;
    }
    break;
  }
  return supplied !== undefined && supplied > 0 ? supplied : DEFAULT_FPS;
}

function parseMicroDvd(text: string, fps: number): Cue[] {
  const cues: Cue[] = [];
  for (const line of text.split("\n")) {
    const match = MICRODVD_LINE.exec(line.trim());
    if (!match) continue;
    if (isFpsDeclaration(match)) continue;

    const startFrame = Number(match[1]);
    const endFrame = match[2] ? Number(match[2]) : startFrame;
    const body = cleanText(match[3] ?? "", "microdvd");
    if (body === "") continue;

    const start = Math.round((startFrame / fps) * 1000);
    const end = Math.round((endFrame / fps) * 1000);
    cues.push({ start, end: Math.max(end, start), text: body });
  }
  return cues;
}

function parseMpl2(text: string): Cue[] {
  const cues: Cue[] = [];
  for (const line of text.split("\n")) {
    const match = MPL2_LINE.exec(line.trim());
    if (!match) continue;

    const start = Number(match[1]) * 100;
    const end = match[2] ? Number(match[2]) * 100 : start;
    const body = cleanText(match[3] ?? "", "mpl2");
    if (body === "") continue;

    cues.push({ start, end: Math.max(end, start), text: body });
  }
  return cues;
}

/** How long a TMPlayer line stays up when the next one is far away. */
const TMPLAYER_FALLBACK_MS = 2000;

function parseTmplayer(text: string): Cue[] {
  const starts: { start: number; text: string }[] = [];
  for (const line of text.split("\n")) {
    const match = TMPLAYER_LINE.exec(line.trim());
    if (!match) continue;

    const start = (Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000;
    const body = cleanText(match[4] ?? "", "tmplayer");
    if (body === "") continue;

    starts.push({ start, text: body });
  }

  // The format gives no end times, so a line runs until the next one, capped so
  // a gap in the dialogue does not leave one line on screen for minutes.
  return starts.map((cue, i) => {
    const next = starts[i + 1]?.start;
    const capped = cue.start + TMPLAYER_FALLBACK_MS;
    const end = next !== undefined ? Math.min(next, capped) : capped;
    return { start: cue.start, end: Math.max(end, cue.start), text: cue.text };
  });
}

export interface ParseOptions {
  /** What the source claims the video runs at. Only MicroDVD needs it. */
  fps?: number | undefined;
}

/** Parses SRT, WebVTT, ASS/SSA, MicroDVD, MPL2 or TMPlayer into a cue list. */
export function parseSubtitle(input: string, options: ParseOptions = {}): Cue[] {
  const text = input.replace(/^﻿/, "").replace(/\r\n?/g, "\n");

  let cues: Cue[];
  switch (detectFormat(text)) {
    case "ass":
      cues = parseAss(text);
      break;
    case "microdvd":
      cues = parseMicroDvd(text, microDvdFps(text, options.fps));
      break;
    case "mpl2":
      cues = parseMpl2(text);
      break;
    case "tmplayer":
      cues = parseTmplayer(text);
      break;
    default:
      cues = parseCueList(text);
  }

  cues.sort((a, b) => a.start - b.start || a.end - b.end);
  return cues;
}
