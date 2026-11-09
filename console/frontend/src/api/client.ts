import axios from "axios";

// All API calls go through /api (Vite proxies it in dev; the FastAPI app serves both in prod).
export const http = axios.create({ baseURL: "/api", timeout: 120_000 });

export interface FieldError { loc: (string | number)[]; msg: string; type?: string }

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly errors: FieldError[];

  constructor(message: string, status: number, code = "error", errors: FieldError[] = []) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.errors = errors;
  }
}

export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (axios.isAxiosError(err)) {
    if (err.code === "ECONNABORTED") {
      return new ApiError("Request timed out waiting for Vertex AI / BigQuery. Please try again.", 408, "timeout");
    }
    const status = err.response?.status ?? 0;
    const data = err.response?.data as { error?: string; code?: string; errors?: FieldError[]; detail?: unknown } | undefined;
    if (data && typeof data === "object" && data.error) {
      return new ApiError(data.error, status, data.code ?? String(status), data.errors ?? []);
    }
    if (status === 0) return new ApiError("Can't reach the Console API. Is the backend running?", 0, "network");
    return new ApiError(err.message || `Request failed (${status})`, status, String(status));
  }
  return new ApiError(err instanceof Error ? err.message : String(err), 0, "unknown");
}

type Params = Record<string, string | number | boolean | null | undefined>;

function clean(params?: Params): Record<string, string | number | boolean> | undefined {
  if (!params) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") out[k] = v;
  return out;
}

export async function apiGet<T>(url: string, params?: Params, signal?: AbortSignal): Promise<T> {
  try {
    return (await http.get<T>(url, { params: clean(params), signal })).data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function apiSend<T>(method: "post" | "put" | "delete", url: string, body?: unknown): Promise<T> {
  try {
    return (await http.request<T>({ method, url, data: body })).data;
  } catch (err) {
    throw toApiError(err);
  }
}
