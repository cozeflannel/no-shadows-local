import { useEffect, useState } from "react";

import type { Json } from "../../api/types";
import { cx, Input, Textarea } from "../ui";

/** Validated JSON editor (scalar sections get a plain input). Calls onChange only with valid JSON. */
export function JsonEditor({ value, onChange, onValidity, resetKey, disabled }: {
  value: Json; onChange: (v: Json) => void; onValidity: (ok: boolean) => void; resetKey: string; disabled?: boolean;
}) {
  const scalar = value === null || typeof value !== "object";
  const [text, setText] = useState(() => (scalar ? String(value ?? "") : JSON.stringify(value, null, 2)));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setText(scalar ? String(value ?? "") : JSON.stringify(value, null, 2));
    setError(null);
    onValidity(true);
    // reset only when the section (or saved version) changes, not on every keystroke
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  if (scalar) {
    return <Input value={text} disabled={disabled} onChange={(e) => { setText(e.target.value); onChange(e.target.value); }} className="max-w-md font-mono" />;
  }

  return (
    <div>
      <Textarea
        value={text}
        disabled={disabled}
        spellCheck={false}
        rows={24}
        aria-invalid={!!error}
        className={cx("min-h-[24rem]", error && "border-rose-400 focus:border-rose-500 focus:ring-rose-500/40")}
        onChange={(e) => {
          setText(e.target.value);
          try {
            const parsed = JSON.parse(e.target.value) as Json;
            setError(null);
            onValidity(true);
            onChange(parsed);
          } catch (err) {
            setError(err instanceof Error ? err.message : "Invalid JSON");
            onValidity(false);
          }
        }}
      />
      <p className={cx("mt-1 text-xs", error ? "text-rose-600 dark:text-rose-400" : "text-zinc-400")}>
        {error ? `JSON error: ${error}` : "Valid JSON. The server validates it against the AgentConfig schema when you save."}
      </p>
    </div>
  );
}
