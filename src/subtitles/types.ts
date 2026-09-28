/** One subtitle line. Times are milliseconds from the start of the video. */
export interface Cue {
  start: number;
  end: number;
  text: string;
}

export type SubtitleFormat = "srt" | "vtt" | "ass" | "microdvd" | "mpl2" | "tmplayer";
