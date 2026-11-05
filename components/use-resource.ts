"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "@/lib/ui";

/** Keep stale data visible on a network failure; discard late responses after navigation. */
export function useResource<T>(url: string, poll = 5000) {
  const [state, setState] = useState<{ url: string; data: T | null; error: string }>({ url, data: null, error: "" });
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    try {
      const data = await api<T>(url);
      if (current === generation.current) setState({ url, data, error: "" });
    } catch (error) {
      if (current === generation.current) {
        setState((previous) => ({ url, data: previous.url === url ? previous.data : null, error: errorMessage(error) }));
      }
    }
  }, [url]);
  useEffect(() => {
    void refresh();
    const timer = poll ? setInterval(() => { if (!document.hidden) void refresh(); }, poll) : null;
    const onFocus = () => { void refresh(); };
    window.addEventListener("focus", onFocus);
    window.addEventListener("barker:tasks-changed", onFocus);
    return () => { generation.current += 1; if (timer) clearInterval(timer); window.removeEventListener("focus", onFocus); window.removeEventListener("barker:tasks-changed", onFocus); };
  }, [refresh, poll]);
  return { data: state.url === url ? state.data : null, error: state.url === url ? state.error : "", refresh };
}
