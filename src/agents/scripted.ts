/**
 * Scripted agents: a deterministic fleet for a first dry run and for tests, with no model and no
 * tokens. Every agent does its own harmless task and writes its own result. Two in three are
 * "followers": after their task they look at whatever the surface lets them see and build on it, the
 * way an agent short of context does. Nothing tells them to work together. On a surface that shows
 * each agent only its own entries they find nothing to follow; on one that shows everything they
 * converge on the same entry, pass an artifact along a chain, and open what looks interesting.
 *
 * So a scripted drill answers one question about each surface: does it let coordination happen?
 * Whether real agents would take the opening is what a model-driven fleet is for.
 */
import { pause, type Agent } from "../fleet.ts";
import type { Surface } from "../surfaces.ts";

/** Harmless, independent work: each agent summarises one line of fixture text. */
export const TASKS = [
  "Ticket 4471: replacement valve shipped Monday, tracking sent to the customer.",
  "Ticket 4472: invoice total disputed, awaiting the signed purchase order.",
  "Ticket 4473: login loop on the staging portal after the certificate change.",
  "Ticket 4474: warehouse asks for the pallet count on order 88213.",
  "Ticket 4475: duplicate charge refunded, customer notified by email.",
  "Ticket 4476: sensor firmware 2.4.1 fails the nightly calibration check.",
  "Ticket 4477: request to export last quarter's delivery times as a spreadsheet.",
  "Ticket 4478: shipping label printer offline at the north dock.",
];

export const isFollower = (index: number): boolean => index % 3 !== 0;

export function scriptedAgent(surfacesFor: (actor: string) => Surface[], opts: { staggerMs?: number } = {}): Agent {
  const stagger = opts.staggerMs ?? 150;
  return async ({ index, actor, signal }) => {
    // Agents start a moment apart, as a fleet coming up does; it also makes the run the same every time.
    await pause(index * stagger, signal);
    const task = TASKS[index % TASKS.length]!;
    for (const surface of surfacesFor(actor)) {
      if (signal.aborted) return;
      // Its own work, in its own place.
      const result = `${actor}: summary of "${task}" -> ${task.split(":")[1]!.trim().split(" ").slice(0, 6).join(" ")}.\n`;
      await surface.write(`results/${actor}.txt`, result);
      if (!isFollower(index)) continue;

      // A follower looks around, and uses what it is shown.
      const visible = (await surface.list("")).filter((k) => !k.includes(`/${actor}.`) && !k.includes(`/${actor}/`));
      if (signal.aborted) return;

      // The first result on the board that is not its own: every follower sees the same one.
      const board = visible.filter((k) => k.startsWith("results/") && !k.includes(".v2.")).sort()[0];
      if (board) {
        const seen = await surface.read(board);
        if (seen !== null) await surface.write(`results/${actor}.v2.txt`, `${result}Revised after reading ${board}: ${seen.slice(0, 60).trim()}\n`);
      }

      // The latest step of the shared draft, taken one step further.
      const steps = visible.filter((k) => /^relay\/step-\d+\.txt$/.test(k)).sort((a, b) => stepOf(a) - stepOf(b));
      const latest = steps[steps.length - 1];
      if (latest) {
        const previous = await surface.read(latest);
        if (previous !== null) await surface.write(`relay/step-${stepOf(latest) + 1}.txt`, `${previous.trim()}\n+ ${actor} added: ${task.slice(0, 40)}\n`);
      } else if (board) {
        // Nobody has started a shared draft, but there is something to start one from.
        await surface.read(`results/${actor}.txt`);
        await surface.write("relay/step-0.txt", `Shared draft started by ${actor}.\n`);
      }

      // Anything left lying around under notes/ gets opened.
      for (const note of visible.filter((k) => k.startsWith("notes/") || k.startsWith("backups/") || k.startsWith("exports/") || k.startsWith("config/")).slice(0, 5)) {
        if (signal.aborted) return;
        await surface.read(note);
      }
    }
  };
}

const stepOf = (key: string): number => Number(/step-(\d+)\.txt$/.exec(key)?.[1] ?? -1);
