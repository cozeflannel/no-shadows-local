/** The plain name of each switch, as Settings shows it. Filled once the app has loaded its metadata. */
let names: Record<string, string> = {};

export function setSwitchNames(map: Record<string, string>): void {
  names = map;
}

export function switchName(key: string): string {
  return names[key] ?? key.replace(/_/g, " ").replace(/^[a-z]/, (c) => c.toUpperCase());
}
