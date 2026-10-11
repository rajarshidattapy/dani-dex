export interface TalkKeyBinding {
  key: string;
  label: string;
}
const STORAGE_KEY = "dani-dex.talk-key.v1";
export const defaultTalkKey = (platform: string): TalkKeyBinding =>
  platform === "darwin" ? { key: "Meta", label: "Command" } : { key: "Control", label: "Control" };
export function readTalkKey(platform: string): TalkKeyBinding {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (value && typeof value.key === "string" && typeof value.label === "string" && validTalkKey(value.key))
      return value;
  } catch {
    /* A missing or invalid preference uses the platform default. */
  }
  return defaultTalkKey(platform);
}
export function validTalkKey(key: string): boolean {
  return ["Meta", "Control", "Alt", "Shift"].includes(key) || /^F(?:[2-9]|1[0-2])$/.test(key);
}
export function saveTalkKey(binding: TalkKeyBinding): void {
  if (!validTalkKey(binding.key))
    throw new Error("Choose a modifier or F2-F12. Typing keys and reserved shortcuts are not supported.");
  localStorage.setItem(STORAGE_KEY, JSON.stringify(binding));
  window.dispatchEvent(new Event("dani-talk-key-change"));
}
