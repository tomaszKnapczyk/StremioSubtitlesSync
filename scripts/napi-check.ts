/**
 * Asks NapiProjekt whether it has Polish subtitles for files on the account.
 *
 * NapiProjekt indexes by the MD5 of a file's first 10 MiB, which Stremio never
 * sends, so the only way to ask is to read those bytes back out of the debrid
 * account. That is inbound traffic, free on the host, but it is real bandwidth
 * per file, so this runs on demand rather than as part of serving a request.
 *
 *   npm run check:napi -- <part of a filename>   [max files]
 */
import { createHash } from "node:crypto";

const API = (process.env.TORBOX_API_BASE ?? "https://api.torbox.app/v1/api").replace(/\/+$/, "");
const KINDS = ["torrents", "usenet", "webdl"] as const;
const ID_PARAM: Record<string, string> = {
  torrents: "torrent_id",
  usenet: "usenet_id",
  webdl: "web_id",
};
const HASH_BYTES = 10 * 1024 * 1024;
const VIDEO = /\.(mkv|mp4|avi|m4v|mov|ts|m2ts)$/i;

interface File {
  kind: string;
  containerId: number;
  fileId: number;
  name: string;
  size: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Port of NapiProjekt's checksum over the file hash. Verified against vectors. */
function napiSubhash(md5: string): string {
  const idx = [0xe, 0x3, 0x6, 0x8, 0x2];
  const mul = [2, 2, 5, 4, 3];
  const add = [0, 0xd, 0x10, 0xb, 0x5];
  let out = "";
  for (let k = 0; k < idx.length; k++) {
    const t = add[k]! + parseInt(md5[idx[k]!]!, 16);
    const v = parseInt(md5.slice(t, t + 2), 16);
    out += (v * mul[k]!).toString(16).slice(-1);
  }
  return out;
}

async function listFiles(key: string): Promise<File[]> {
  const out: File[] = [];
  for (const kind of KINDS) {
    try {
      const response = await fetch(`${API}/${kind}/mylist?limit=1000&offset=0`, {
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) continue;
      const body: unknown = await response.json();
      const items = isRecord(body) && Array.isArray(body["data"]) ? body["data"] : [];
      for (const item of items) {
        if (!isRecord(item)) continue;
        const containerId = Number(item["id"]);
        const files = Array.isArray(item["files"]) ? item["files"] : [];
        for (const file of files) {
          if (!isRecord(file)) continue;
          const name = String(file["short_name"] ?? file["name"] ?? "");
          const size = Number(file["size"] ?? 0);
          if (name === "" || size === 0) continue;
          out.push({ kind, containerId, fileId: Number(file["id"]), name, size });
        }
      }
    } catch {
      // One unavailable list must not hide the other two.
    }
  }
  return out;
}

async function downloadLink(key: string, file: File): Promise<string | null> {
  const params = new URLSearchParams({
    token: key,
    [ID_PARAM[file.kind] ?? "torrent_id"]: String(file.containerId),
    file_id: String(file.fileId),
  });
  const response = await fetch(`${API}/${file.kind}/requestdl?${params.toString()}`, {
    headers: { Accept: "application/json" },
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) return null;
  const body: unknown = await response.json();
  const link = isRecord(body) ? body["data"] : undefined;
  return typeof link === "string" && link !== "" ? link : null;
}

/** MD5 of the first 10 MiB, which is what NapiProjekt keys its index on. */
async function headHash(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { Range: `bytes=0-${HASH_BYTES - 1}` },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok && response.status !== 206) {
    throw new Error(`range request returned ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < HASH_BYTES) {
    throw new Error(`only ${bytes.length} of ${HASH_BYTES} bytes came back`);
  }
  return createHash("md5").update(bytes).digest("hex");
}

async function askNapi(md5: string): Promise<{ status: string; bytes: number }> {
  const params = new URLSearchParams({
    v: "dreambox",
    kolejka: "false",
    nick: "",
    pass: "",
    napios: "Linux",
    l: "PL",
    f: md5,
    t: napiSubhash(md5),
  });
  const response = await fetch(`https://napiprojekt.pl/unit_napisy/dl.php?${params.toString()}`, {
    signal: AbortSignal.timeout(30_000),
  });
  const body = Buffer.from(await response.arrayBuffer());

  if (body.subarray(0, 4).toString("latin1") === "NPc0") return { status: "brak", bytes: 0 };
  if (body.subarray(0, 4).toString("hex") === "377abcaf") {
    return { status: "SA, ale w archiwum 7z", bytes: body.length };
  }
  if (body.length === 0) return { status: "pusta odpowiedz", bytes: 0 };
  return { status: "SA, tekstem", bytes: body.length };
}

async function main(): Promise<void> {
  const key = process.env.TORBOX_API_KEY;
  if (!key) {
    console.error("TORBOX_API_KEY nie jest ustawiony");
    process.exitCode = 1;
    return;
  }

  const needle = (process.argv[2] ?? "").toLowerCase();
  const limit = Number(process.argv[3] ?? 5);

  const all = await listFiles(key);
  const videos = all.filter((f) => VIDEO.test(f.name) && f.size > 50 * 1024 * 1024);
  console.log(`Konto trzyma ${all.length} plikow, w tym ${videos.length} plikow wideo.`);

  const picked = (needle ? videos.filter((f) => f.name.toLowerCase().includes(needle)) : videos)
    .sort((a, b) => b.size - a.size)
    .slice(0, limit);

  if (picked.length === 0) {
    console.log(needle ? `Nic nie pasuje do "${needle}".` : "Brak plikow wideo.");
    return;
  }

  for (const file of picked) {
    console.log();
    console.log(`${file.name}  (${(file.size / 1e9).toFixed(2)} GB)`);
    try {
      const url = await downloadLink(key, file);
      if (!url) {
        console.log("  -> TorBox nie dal linku");
        continue;
      }
      const md5 = await headHash(url);
      const answer = await askNapi(md5);
      console.log(`  md5(10MiB)=${md5}  subhash=${napiSubhash(md5)}`);
      console.log(`  NapiProjekt: ${answer.status}${answer.bytes ? ` (${answer.bytes} bajtow)` : ""}`);
    } catch (error) {
      console.log(`  -> ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

void main();
