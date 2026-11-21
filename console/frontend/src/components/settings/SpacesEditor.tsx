import { Field, Input } from "../ui";

type Space = { key: string; display_name: string; space_id?: string };
type SpacesValue = Space[];

const SPACE_KEYS = [
  { key: "burson", label: "Burson alerts space", help: "The space where Burson/Zapier posts alerts." },
  { key: "clean", label: "Triaged alerts space", help: "Where the agent posts cleaned alerts for IMs." },
  { key: "mirror", label: "Mirror space", help: "The space the agent works in for auto-corrections and actions." },
  { key: "autocorrect", label: "Auto-correct space", help: "Optional dedicated space for corrections. Leave blank to use Mirror." },
  { key: "team", label: "Team space", help: "24/7 SL team space for handovers and escalations." },
];

export function SpacesEditor({ value, onChange, disabled }: {
  value: SpacesValue; onChange: (v: SpacesValue) => void; disabled?: boolean;
}) {
  const byKey = Object.fromEntries(value.map((s) => [s.key, s]));
  const setSpace = (key: string, patch: Partial<Space>) => {
    const existing = byKey[key] || { key, display_name: SPACE_KEYS.find((k) => k.key === key)?.label || key };
    const next = { ...existing, ...patch };
    const others = value.filter((s) => s.key !== key);
    onChange([...others, next]);
  };
  return (
    <div className="space-y-6">
      {SPACE_KEYS.map((def) => {
        const s = byKey[def.key] || { key: def.key, display_name: def.label };
        return (
          <div key={def.key} className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
            <h3 className="text-sm font-medium">{def.label}</h3>
            <p className="mt-0.5 text-xs text-zinc-500">{def.help}</p>
            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
              <Field label="Space ID">
                <Input value={s.space_id || ""} placeholder="spaces/AAQAxxxxxx" disabled={disabled}
                  onChange={(e) => setSpace(def.key, { space_id: e.target.value.trim() || undefined })} />
              </Field>
              <Field label="Display name">
                <Input value={s.display_name || ""} disabled={disabled}
                  onChange={(e) => setSpace(def.key, { display_name: e.target.value })} />
              </Field>
            </div>
          </div>
        );
      })}
    </div>
  );
}
