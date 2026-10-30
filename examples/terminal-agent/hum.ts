/// <reference lib="dom" />
/**
 * A few seconds of sound for the gallery to play: a hum that swells and
 * fades as speech does, as a WAV, with its peaks (64, 0 to 1) as a
 * recording made in the composer has them.
 */
export function hum(seconds: number): { blob: Blob; url: string; peaks: number[] } {
  const rate = 16_000;
  const samples = Math.round(seconds * rate);
  const wav = new DataView(new ArrayBuffer(44 + samples * 2));
  const text = (at: number, word: string) =>
    [...word].forEach((c, i) => wav.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  wav.setUint32(4, 36 + samples * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  wav.setUint32(16, 16, true);
  wav.setUint16(20, 1, true); // PCM
  wav.setUint16(22, 1, true); // mono
  wav.setUint32(24, rate, true);
  wav.setUint32(28, rate * 2, true);
  wav.setUint16(32, 2, true);
  wav.setUint16(34, 16, true);
  text(36, "data");
  wav.setUint32(40, samples * 2, true);
  // Syllables, louder and quieter phrases, and a breath between them.
  const loudness = (t: number) =>
    Math.abs(Math.sin(Math.PI * t * 3.7)) ** 0.7 *
    (0.45 + 0.55 * Math.abs(Math.sin(t * 0.9 + 0.4))) *
    (t % 2.1 > 1.75 ? 0.06 : 1);
  for (let i = 0; i < samples; i++) {
    const t = i / rate;
    const voice = Math.sin(2 * Math.PI * 165 * t) * 0.6 + Math.sin(2 * Math.PI * 330 * t) * 0.25;
    wav.setInt16(44 + i * 2, Math.round(loudness(t) * voice * 11_000), true);
  }
  // Each peak is its stretch's average loudness, as a recording's are.
  const peaks = Array.from({ length: 64 }, (_, i) => {
    let sum = 0;
    for (let k = 0; k < 24; k++) sum += loudness((i + k / 24) / 64 * seconds);
    return Math.round(Math.min(1, sum / 24) * 100) / 100;
  });
  const blob = new Blob([wav.buffer], { type: "audio/wav" });
  return { blob, url: URL.createObjectURL(blob), peaks };
}
