import { createSignal, onCleanup, Show } from "solid-js";
import { Button } from "../../components/ui";
import { defaultTalkKey, readTalkKey, saveTalkKey, validTalkKey } from "./talk-key";
export function TalkKeyPicker(props: { platform: string }) {
  const [binding, setBinding] = createSignal(readTalkKey(props.platform));
  const [capturing, setCapturing] = createSignal(false);
  const [error, setError] = createSignal("");
  function chooseDefault() {
    const value = defaultTalkKey(props.platform);
    saveTalkKey(value);
    setBinding(value);
    setCapturing(false);
    setError("");
  }
  function capture(event: KeyboardEvent) {
    if (!capturing()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.key === "Escape") {
      setCapturing(false);
      setError("");
      return;
    }
    if (event.repeat) return;
    if (
      !validTalkKey(event.key) ||
      ((event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) &&
        !["Meta", "Control", "Alt", "Shift"].includes(event.key))
    ) {
      setError("Choose one modifier or F2-F12, not a typing key or shortcut.");
      return;
    }
    const value = { key: event.key, label: event.key === "Meta" ? "Command" : event.key };
    try {
      saveTalkKey(value);
      setBinding(value);
      setCapturing(false);
      setError("");
    } catch {
      setError("Could not save your talk key.");
    }
  }
  window.addEventListener("keydown", capture, true);
  onCleanup(() => window.removeEventListener("keydown", capture, true));
  return (
    <div class="talk-key-picker">
      <div class="talk-key-options">
        <Button
          variant="ghost"
          type="button"
          class="talk-key-default"
          aria-pressed={binding().key === defaultTalkKey(props.platform).key ? "true" : "false"}
          onClick={chooseDefault}
        >
          <span class="talk-key-symbol">{props.platform === "darwin" ? "⌘" : "Ctrl"}</span>
          <span>{defaultTalkKey(props.platform).label}</span>
        </Button>
        <Button
          variant="ghost"
          type="button"
          class="talk-key-custom"
          aria-label="Choose a custom talk key"
          aria-pressed={capturing() ? "true" : "false"}
          onClick={() => {
            setCapturing(true);
            setError("");
          }}
        >
          +
        </Button>
      </div>
      <p class="talk-key-note">
        {defaultTalkKey(props.platform).label} is the default on {props.platform === "darwin" ? "Mac" : "this computer"}
        . You can change this later.
      </p>
      <Show when={binding().key !== defaultTalkKey(props.platform).key}>
        <p role="status">Talk key: {binding().label}</p>
      </Show>
      <Show when={capturing()}>
        <p role="status">Press a modifier or F2-F12. Escape cancels.</p>
      </Show>
      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>
      <p class="talk-key-scope">Works in the focused conversation. No system-wide listening.</p>
    </div>
  );
}
