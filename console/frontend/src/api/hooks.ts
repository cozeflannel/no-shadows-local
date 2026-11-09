import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, apiGet, toApiError } from "./client";

type Params = Record<string, string | number | boolean | null | undefined>;

export interface ApiState<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
  setData: (value: T | null) => void;
}

/** GET `url` (null = skip) and keep it fresh; re-fetches when params change or every `refreshMs`. */
export function useApi<T>(url: string | null, params?: Params, refreshMs?: number): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState<boolean>(url !== null);
  const [tick, setTick] = useState(0);
  const key = JSON.stringify(params ?? {});
  const lastKey = useRef<string | null>(null);

  useEffect(() => {
    if (url === null) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    const fetchKey = `${url}?${key}`;
    if (lastKey.current !== fetchKey) {
      lastKey.current = fetchKey;
      setLoading(true);  // new query: show a loader; polling refreshes stay silent
    }
    apiGet<T>(url, JSON.parse(key) as Params, controller.signal)
      .then((value) => {
        setData(value);
        setError(null);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(toApiError(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [url, key, tick]);

  useEffect(() => {
    if (!refreshMs || url === null) return;
    const id = window.setInterval(() => setTick((t) => t + 1), refreshMs);
    return () => window.clearInterval(id);
  }, [refreshMs, url]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload, setData };
}

/** Wrap an async action with loading/error state (buttons disable while it runs). */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const run = useCallback(
    async (...args: A): Promise<R | undefined> => {
      setLoading(true);
      setError(null);
      try {
        return await fn(...args);
      } catch (err) {
        setError(toApiError(err));
        return undefined;
      } finally {
        setLoading(false);
      }
    },
    [fn],
  );
  return { run, loading, error, setError };
}
