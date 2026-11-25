// Real colour grading for the photo bank (Canva's tools cannot adjust a photo's colours). Pure image maths with sharp;
// the original picture is never touched, the result is saved as a new picture.
import { StudioError } from "./types.js";

export type Grade = {
  exposure: number;   // -1 darker .. +1 brighter
  contrast: number;   // -1 flatter .. +1 punchier
  saturation: number; // -1 grey .. +1 vivid
  warmth: number;     // -1 cool (blue) .. +1 warm (orange)
  tint: number;       // -1 green .. +1 magenta
  fade: number;       // 0 .. 1 lifted, matte blacks
  vignette: number;   // 0 .. 1 darker corners
  sharpen: number;    // 0 .. 1
};

const NEUTRAL: Grade = { exposure: 0, contrast: 0, saturation: 0, warmth: 0, tint: 0, fade: 0, vignette: 0, sharpen: 0 };

export const PRESETS: Record<string, Partial<Grade>> = {
  hangat: { warmth: 0.35, saturation: 0.1, contrast: 0.1, exposure: 0.05 },
  sejuk: { warmth: -0.3, saturation: -0.05, contrast: 0.1 },
  sinematik: { contrast: 0.25, saturation: -0.1, warmth: 0.15, tint: 0.1, vignette: 0.35, fade: 0.15 },
  cerah: { exposure: 0.2, contrast: 0.1, saturation: 0.15, sharpen: 0.3 },
  moody: { exposure: -0.2, contrast: 0.3, saturation: -0.2, vignette: 0.4 },
  matte: { fade: 0.5, contrast: -0.1, saturation: -0.1 },
  "hitam-putih": { saturation: -1, contrast: 0.2 },
};
export const PRESET_NAMES = Object.keys(PRESETS);

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Preset first, then any explicit numbers on top. Values are clamped to their range. */
export function resolveGrade(preset: string | undefined, over: Partial<Grade>): Grade {
  if (preset && !PRESETS[preset]) throw new StudioError(`Preset "${preset}" tak wujud. Pilih: ${PRESET_NAMES.join(", ")}.`);
  const g = { ...NEUTRAL, ...(preset ? PRESETS[preset] : {}) };
  for (const [k, v] of Object.entries(over)) if (typeof v === "number" && Number.isFinite(v)) (g as Record<string, number>)[k] = v;
  const lim = (v: number, signed: boolean) => clamp(v, signed ? -1 : 0, 1);
  return {
    exposure: lim(g.exposure, true), contrast: lim(g.contrast, true), saturation: lim(g.saturation, true), warmth: lim(g.warmth, true),
    tint: lim(g.tint, true), fade: lim(g.fade, false), vignette: lim(g.vignette, false), sharpen: lim(g.sharpen, false),
  };
}

export const isNeutral = (g: Grade) => Object.values(g).every((v) => v === 0);

/** Returns the graded picture as a JPEG (longest side at most 2048 px), plus a small preview JPEG for Claude to look at. */
export async function gradeImage(input: Buffer, g: Grade): Promise<{ jpeg: Buffer; preview: Buffer; width: number; height: number }> {
  const sharp = (await import("sharp")).default; // loaded only when needed so other tools stay fast
  let base: { data: Buffer; info: { width: number; height: number } };
  try {
    base = await sharp(input, { failOn: "error" }).rotate().flatten({ background: "#ffffff" })
      .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
      .toBuffer({ resolveWithObject: true });
  } catch { throw new StudioError("Gambar ni tak boleh dibuka untuk di-grade. Cuba upload semula sebagai JPEG atau PNG."); }
  const { width, height } = base.info;

  let img = sharp(base.data);
  img = img.modulate({ brightness: 1 + g.exposure * 0.35, saturation: 1 + g.saturation });
  const c = g.contrast * 0.5;
  img = img.linear(1 + c - g.fade * 0.1, -(128 * c) + 255 * 0.08 * g.fade);
  // warmth 1 = red x1.28, blue x0.72 (a strong orange cast); a preset's 0.3 is a clearly visible but natural shift
  if (g.warmth || g.tint) img = img.recomb([[1 + 0.28 * g.warmth, 0, 0], [0, 1 - 0.12 * g.tint, 0], [0, 0, 1 - 0.28 * g.warmth]]);
  if (g.sharpen) img = img.sharpen({ sigma: 0.6 + g.sharpen });
  if (g.vignette) {
    // pixel units (not percentages) so the gradient is a true circle around the centre whatever the picture's shape
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><radialGradient id="v" gradientUnits="userSpaceOnUse" cx="${width / 2}" cy="${height / 2}" r="${(Math.hypot(width, height) / 2).toFixed(1)}"><stop offset="0.5" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="${(0.55 * g.vignette).toFixed(3)}"/></radialGradient></defs><rect x="0" y="0" width="${width}" height="${height}" fill="url(#v)"/></svg>`;
    img = img.composite([{ input: Buffer.from(svg), blend: "over" }]);
  }
  const jpeg = await img.jpeg({ quality: 90 }).toBuffer();
  const preview = await sharp(jpeg).resize({ width: 640, height: 640, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 75 }).toBuffer();
  return { jpeg, preview, width, height };
}

/** A picture in a format Threads takes (JPEG/PNG) as-is; anything else sharp can read (WebP, GIF, AVIF...) becomes a JPEG; a
 *  JPEG/PNG over 8 MB is shrunk. Used for pictures arriving from a link (e.g. a Canva export). */
export async function toThreadsFormat(buf: Buffer, max: number, isOk: (b: Buffer) => boolean): Promise<Buffer> {
  if (isOk(buf) && buf.length <= max) return buf;
  const sharp = (await import("sharp")).default;
  try {
    return await sharp(buf, { failOn: "error" }).rotate().flatten({ background: "#ffffff" })
      .resize({ width: 2560, height: 2560, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
  } catch { throw new StudioError("Fail itu bukan gambar yang boleh dibaca. Minta export sebagai PNG atau JPG."); }
}
