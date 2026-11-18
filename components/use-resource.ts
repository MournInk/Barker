"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "@/lib/ui";
import { createResourcePoller } from "@/lib/resource";

/** Keep stale data visible on a network failure; discard late responses after navigation. */
export function useResource<T>(url: string, poll = 5000) {
  const [state, setState] = useState<{ url: string; data: T | null; error: string }>({ url, data: null, error: "" });
  const poller = useRef<{ url: string; refresh: () => Promise<void> } | null>(null);
  const refresh = useCallback(async () => {
    if (poller.current?.url === url) await poller.current.refresh();
  }, [url]);
  useEffect(() => {
    const resource = createResourcePoller<T>({ load: (signal) => api<T>(url, { signal }), interval: poll, visible: () => !document.hidden,
      data: (data) => setState({ url, data, error: "" }),
      error: (error) => setState((previous) => ({ url, data: previous.url === url ? previous.data : null, error: errorMessage(error) })) });
    poller.current = { url, refresh: resource.refresh };
    void resource.refresh();
    const onFocus = () => { if (!document.hidden) void resource.refresh(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener("barker:tasks-changed", onFocus);
    return () => { resource.stop(); window.removeEventListener("focus", onFocus); document.removeEventListener("visibilitychange", onFocus); window.removeEventListener("barker:tasks-changed", onFocus); };
  }, [url, poll]);
  return { data: state.url === url ? state.data : null, error: state.url === url ? state.error : "", refresh };
}
