export function createResourcePoller<T>(options: {
  load: (signal: AbortSignal) => Promise<T>;
  data: (data: T) => void;
  error: (error: unknown) => void;
  interval: number;
  visible: () => boolean;
}) {
  let stopped = false;
  let pending: Promise<void> | null = null;
  let refreshAgain = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const schedule = () => {
    if (stopped || !options.interval) return;
    timer = setTimeout(() => {
      if (options.visible()) void refresh();
      else schedule();
    }, options.interval);
  };
  const refresh = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (pending) { refreshAgain = true; return pending; }
    if (timer) clearTimeout(timer);
    pending = Promise.resolve().then(async () => {
      do {
        refreshAgain = false;
        try { const data = await options.load(controller.signal); if (!stopped) options.data(data); }
        catch (error) { if (!stopped) options.error(error); }
      } while (refreshAgain && !stopped);
    })
      .finally(() => { pending = null; schedule(); });
    return pending;
  };
  return { refresh, stop: () => { stopped = true; controller.abort(); if (timer) clearTimeout(timer); } };
}
