// iMessage and the website share the same tools and data files, so the agent answers one message at a time.
let line: Promise<unknown> = Promise.resolve();

export function oneAtATime<T>(job: () => Promise<T>): Promise<T> {
  const next = line.then(job, job);
  line = next.catch(() => undefined);
  return next;
}
