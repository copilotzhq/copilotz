/**
 * Previews and served jobs on the web, their logic: which jobs serve a port
 * (said when started, or found listening), how an address reads, who may
 * open one, in words, a computer's previews in a space, and a job to
 * start, from the form's fields.
 */
import type { Preview } from "../../collections/preview.ts";
import type { Job } from "../../shared/workloads.ts";

/** The ports a job serves: the one it said first, then those it listens on. */
export const portsOf = (
  job: Pick<Job, "port" | "ports">,
): number[] => [...new Set([job.port, ...(job.ports ?? [])].filter((p): p is number => !!p))];

/** Whether a job can be previewed: it runs, and serves a port. */
export const serves = (job: Pick<Job, "running" | "port" | "ports">): boolean =>
  job.running && portsOf(job).length > 0;

/** An address as it reads: its host and path, without the scheme or a trailing slash. */
export const shown = (url: string): string => url.replace(/^https?:\/\//, "").replace(/\/$/, "");

/** Who may open a preview, as the person picks it. */
export const VISIBILITY = {
  members: { label: "Space members", hint: "Only this space's members, signed in" },
  link: { label: "Anyone with the link", hint: "Anyone who has the address, signed in or not" },
} as const;

export type Visibility = keyof typeof VISIBILITY;

/** A computer's previews in a space, the newest first. */
export const previewsAt = (previews: Preview[], computer: string, space: string): Preview[] =>
  previews.filter((p) => p.computer === computer && p.space === space)
    .sort((a, b) => b.at.localeCompare(a.at));

/** The preview of a job (the newest, when there are several). */
export const previewOfJob = (previews: Preview[], job: string): Preview | undefined =>
  previews.find((p) => p.job === job);

/** What a job to start is, from the form: its command, name, port and whether it's kept; or what's wrong. */
export function jobToStart(
  form: { command: string; name: string; port: string; keep: boolean },
): { command: string; name?: string; port?: number; keep?: true } | { error: string } {
  const command = form.command.trim();
  if (!command) return { error: "Say what to run." };
  const port = form.port.trim();
  const number = Number(port);
  if (port && !(Number.isInteger(number) && number >= 1 && number <= 65535)) {
    return { error: "A port is a whole number from 1 to 65535." };
  }
  return {
    command,
    ...(form.name.trim() ? { name: form.name.trim() } : {}),
    ...(port ? { port: number } : {}),
    ...(form.keep ? { keep: true as const } : {}),
  };
}
