import type { VoiceModelStatus } from "@dani-dex/contracts/ipc";
import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { beforeAll, expect, it, vi } from "vitest";
import { App } from "./App";
import { emitAgentEvent, installDanidexStub, installVoiceRecordingMocks, testServer } from "./app-test-harness";
import { AccountDock, SettingsModal } from "./lazy-views";

// Wait for the app's lazy chunks instead of leaving their imports running after jsdom teardown.
beforeAll(async () => {
  await AccountDock.preload();
  await SettingsModal.preload();
});

function dictationPointerEvent(type: "pointerdown" | "pointerup" | "pointercancel", pointerId = 1): MouseEvent {
  // jsdom has no PointerEvent constructor; preserve pointer identity rather than silently dropping it.
  const event = new MouseEvent(type, { bubbles: true, button: 0 });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  return event;
}

describe("Dani-Dex connected desktop shell", () => {
  beforeEach(() => {
    installDanidexStub();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    window.danidex.voice.requestMicrophoneAccess = vi.fn(async () => true);
  });

  it("explains blocked microphone access, then records and offers the send arrow", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    await fireEvent.click(await screen.findByRole("button", { name: "Create prompt with voice" }));

    await waitFor(() =>
      expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({
        audio: true,
        video: false,
      }),
    );
    expect(
      await screen.findByText("Microphone access is blocked. Allow Dani-Dex to use the microphone in system settings."),
    ).toBeInTheDocument();

    installVoiceRecordingMocks();
    emitAgentEvent?.({
      type: "conversation",
      snapshot: {
        agentId: "chief",
        threadId: "thread-chief",
        activeTurnId: "turn-active",
        revision: 2,
        messages: [],
      },
    });
    await screen.findByRole("button", { name: "Stop agent" });

    await fireEvent.click(screen.getByRole("button", { name: "Create prompt with voice" }));

    const status = await screen.findByRole("group", {
      name: "Voice recording",
    });
    expect(within(status).getByText("0:00")).toBeVisible();
    expect(within(status).getByRole("button", { name: "Stop voice recording" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Create prompt with voice" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send voice message" })).toBeInTheDocument();
  });

  it("downloads the voice model before it requests microphone access", async () => {
    let resolvePreparation: ((status: VoiceModelStatus) => void) | undefined;
    let reportModelStatus: ((status: VoiceModelStatus) => void) | undefined;
    vi.mocked(window.danidex.voice.prepareModel).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePreparation = resolve;
        }),
    );
    vi.mocked(window.danidex.voice.onModelStatus).mockImplementationOnce((listener) => {
      reportModelStatus = listener;
      return () => undefined;
    });
    render(() => <App />);

    await fireEvent.click(await screen.findByRole("button", { name: "Create prompt with voice" }));
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    reportModelStatus?.({ phase: "downloading", progress: 47, message: null });
    await waitFor(() => {
      expect(screen.getAllByRole("status").some((status) => status.textContent?.includes("47%"))).toBe(true);
    });

    resolvePreparation?.({ phase: "ready", progress: 100, message: null });
    await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce());
  });

  it("ignores a cancelled conversation's deferred voice setup error", async () => {
    const local = testServer("local", true);
    const remote = testServer("remote-1", false);
    let resolvePreparation: ((status: VoiceModelStatus) => void) | undefined;
    vi.mocked(window.danidex.servers.list).mockResolvedValueOnce([local, remote]);
    vi.mocked(window.danidex.servers.select).mockImplementation(async (serverId) => [
      { ...local, active: serverId === "local" },
      { ...remote, active: serverId === "remote-1" },
    ]);
    vi.mocked(window.danidex.voice.prepareModel).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePreparation = resolve;
        }),
    );
    render(() => <App />);

    await fireEvent.click(await screen.findByRole("button", { name: "Create prompt with voice" }));
    await waitFor(() => expect(window.danidex.voice.prepareModel).toHaveBeenCalledOnce());
    await fireEvent.click(screen.getByRole("button", { name: "Studio Mac server" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Studio Mac server" })).toHaveAttribute("aria-pressed", "true"),
    );

    resolvePreparation?.({
      phase: "error",
      progress: 0,
      message: "Local voice setup failed",
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Create prompt with voice" })).toBeEnabled());
    expect(screen.queryByText("Local voice setup failed")).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Local server" }));
    expect(screen.queryByText("Local voice setup failed")).not.toBeInTheDocument();
  });

  it("does not open the microphone for a conversation the user has left", async () => {
    const local = testServer("local", true);
    const remote = testServer("remote-1", false);
    let resolvePreparation: ((status: VoiceModelStatus) => void) | undefined;
    vi.mocked(window.danidex.servers.list).mockResolvedValueOnce([local, remote]);
    vi.mocked(window.danidex.servers.select).mockImplementation(async (serverId) => [
      { ...local, active: serverId === "local" },
      { ...remote, active: serverId === "remote-1" },
    ]);
    vi.mocked(window.danidex.voice.prepareModel).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePreparation = resolve;
        }),
    );
    render(() => <App />);

    await fireEvent.click(await screen.findByRole("button", { name: "Create prompt with voice" }));
    await waitFor(() => expect(window.danidex.voice.prepareModel).toHaveBeenCalledOnce());
    await fireEvent.click(screen.getByRole("button", { name: "Studio Mac server" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Studio Mac server" })).toHaveAttribute("aria-pressed", "true"),
    );

    // The download the user walked away from is not the arriving conversation's
    // problem: it is not told about a model it never asked for, and it can
    // dictate straight away. The preparation is still unresolved at this point,
    // and it may never resolve.
    expect(screen.queryByRole("button", { name: "Downloading voice model" })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Create prompt with voice" })).toBeEnabled());

    resolvePreparation?.({ phase: "ready", progress: 100, message: null });
    await waitFor(() => expect(screen.getByRole("button", { name: "Create prompt with voice" })).toBeEnabled());
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it("discards an unaccepted recording when its conversation unmounts", async () => {
    const local = testServer("local", true);
    const remote = testServer("remote-1", false);
    vi.mocked(window.danidex.servers.list).mockResolvedValueOnce([local, remote]);
    vi.mocked(window.danidex.servers.select).mockImplementation(async (serverId) => [
      { ...local, active: serverId === "local" },
      { ...remote, active: serverId === "remote-1" },
    ]);
    const { stopTrack } = installVoiceRecordingMocks();
    render(() => <App />);

    await fireEvent.click(await screen.findByRole("button", { name: "Create prompt with voice" }));
    await screen.findByRole("group", { name: "Voice recording" });
    await fireEvent.click(screen.getByRole("button", { name: "Studio Mac server" }));
    await waitFor(() => expect(stopTrack).toHaveBeenCalledOnce());
    await fireEvent.click(screen.getByRole("button", { name: "Local server" }));

    const composer = await screen.findByRole("textbox", {
      name: "Message Chief",
    });
    expect(composer).not.toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("button", { name: "Stop voice recording" })).not.toBeInTheDocument();

    await waitFor(() => expect(screen.getByRole("button", { name: "Create prompt with voice" })).toBeEnabled());
    expect(window.danidex.voice.transcribe).not.toHaveBeenCalled();
    expect(window.danidex.agent.sendMessage).not.toHaveBeenCalled();
    expect(composer).toHaveTextContent("");
  });

  it("submits the accepted voice snapshot and preserves later draft changes", async () => {
    let resolveTranscription: ((result: { text: string }) => void) | undefined;
    vi.mocked(window.danidex.voice.transcribe).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTranscription = resolve;
        }),
    );
    installVoiceRecordingMocks();
    render(() => <App />);

    const composer = await screen.findByRole("textbox", {
      name: "Message Chief",
    });
    composer.textContent = "Existing draft";
    await fireEvent.input(composer);
    await fireEvent.click(screen.getByRole("button", { name: "Create prompt with voice" }));
    await screen.findByRole("group", { name: "Voice recording" });
    await fireEvent.click(screen.getByRole("button", { name: "Send voice message" }));
    await waitFor(() => expect(window.danidex.voice.transcribe).toHaveBeenCalledOnce());

    expect(composer).toHaveAttribute("aria-disabled", "true");
    await fireEvent.keyDown(composer, { key: "Enter" });
    expect(window.danidex.agent.sendMessage).not.toHaveBeenCalled();
    composer.textContent = "Later draft";
    await fireEvent.input(composer);

    resolveTranscription?.({ text: "Voice transcript" });
    await waitFor(() =>
      expect(window.danidex.agent.sendMessage).toHaveBeenCalledWith(
        {
          agentId: "chief",
          text: "Existing draft Voice transcript",
          attachmentDraftIds: [],
        },
        "local",
      ),
    );
    expect(window.danidex.agent.sendMessage).toHaveBeenCalledOnce();
    await waitFor(() => expect(composer).toHaveTextContent("Later draft"));
  });

  it("keeps a deferred transcript and its failure with the chat that started them", async () => {
    let resolveTranscription: ((result: { text: string }) => void) | undefined;
    let rejectTranscription: ((error: Error) => void) | undefined;
    vi.mocked(window.danidex.voice.transcribe)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveTranscription = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectTranscription = reject;
          }),
      );
    vi.mocked(window.danidex.servers.list).mockResolvedValue([
      testServer("local", true),
      testServer("remote-1", false),
    ]);
    vi.mocked(window.danidex.servers.select).mockImplementation(async (id) => [
      testServer("local", id === "local"),
      testServer("remote-1", id === "remote-1"),
    ]);
    installVoiceRecordingMocks();
    render(() => <App />);

    await fireEvent.click(await screen.findByRole("button", { name: "Create prompt with voice" }));
    const recording = await screen.findByRole("group", {
      name: "Voice recording",
    });
    await fireEvent.click(within(recording).getByRole("button", { name: "Stop voice recording" }));
    await waitFor(() => expect(window.danidex.voice.transcribe).toHaveBeenCalledOnce());
    await fireEvent.click(screen.getByRole("button", { name: "Studio Mac server" }));

    resolveTranscription?.({ text: "Draft for Chief" });
    await screen.findByRole("button", { name: "Create prompt with voice" });
    expect(window.danidex.agent.sendMessage).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: "Local server" }));
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Message Chief" })).toHaveTextContent("Draft for Chief"),
    );

    await fireEvent.click(screen.getByRole("button", { name: "Create prompt with voice" }));
    await screen.findByRole("group", { name: "Voice recording" });
    await fireEvent.click(screen.getByRole("button", { name: "Send voice message" }));
    await waitFor(() => expect(window.danidex.voice.transcribe).toHaveBeenCalledTimes(2));
    await fireEvent.click(screen.getByRole("button", { name: "Studio Mac server" }));

    rejectTranscription?.(new Error("Transcription failed"));
    await screen.findByRole("button", { name: "Create prompt with voice" });
    expect(screen.queryByText("Transcription failed")).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Local server" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Transcription failed");
    await fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(screen.queryByText("Transcription failed")).not.toBeInTheDocument());
  });

  it("finishes an accepted voice send on the original server after the server changes", async () => {
    const local = testServer("local", true);
    const remote = testServer("remote-1", false);
    let resolveTranscription: ((result: { text: string }) => void) | undefined;
    vi.mocked(window.danidex.servers.list).mockResolvedValueOnce([local, remote]);
    vi.mocked(window.danidex.servers.select).mockImplementation(async (serverId) => [
      { ...local, active: serverId === "local" },
      { ...remote, active: serverId === "remote-1" },
    ]);
    vi.mocked(window.danidex.voice.transcribe).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTranscription = resolve;
        }),
    );
    installVoiceRecordingMocks();
    render(() => <App />);

    await fireEvent.click(await screen.findByRole("button", { name: "Create prompt with voice" }));
    await screen.findByRole("group", { name: "Voice recording" });
    await fireEvent.click(screen.getByRole("button", { name: "Send voice message" }));
    await waitFor(() => expect(window.danidex.voice.transcribe).toHaveBeenCalledOnce());
    await fireEvent.click(screen.getByRole("button", { name: "Studio Mac server" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Studio Mac server" })).toHaveAttribute("aria-pressed", "true"),
    );

    resolveTranscription?.({ text: "Message for local Chief" });
    await waitFor(() =>
      expect(window.danidex.agent.sendMessage).toHaveBeenCalledWith(
        {
          agentId: "chief",
          text: "Message for local Chief",
          attachmentDraftIds: [],
        },
        "local",
      ),
    );
  });

  it("shows a deferred send error on the original server", async () => {
    const local = testServer("local", true);
    const remote = testServer("remote-1", false);
    let resolveTranscription: ((result: { text: string }) => void) | undefined;
    vi.mocked(window.danidex.servers.list).mockResolvedValueOnce([local, remote]);
    vi.mocked(window.danidex.servers.select).mockImplementation(async (serverId) => [
      { ...local, active: serverId === "local" },
      { ...remote, active: serverId === "remote-1" },
    ]);
    vi.mocked(window.danidex.voice.transcribe).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTranscription = resolve;
        }),
    );
    vi.mocked(window.danidex.agent.sendMessage).mockRejectedValueOnce(new Error("Local send failed"));
    installVoiceRecordingMocks();
    render(() => <App />);

    await fireEvent.click(await screen.findByRole("button", { name: "Create prompt with voice" }));
    await screen.findByRole("group", { name: "Voice recording" });
    await fireEvent.click(screen.getByRole("button", { name: "Send voice message" }));
    await waitFor(() => expect(window.danidex.voice.transcribe).toHaveBeenCalledOnce());
    const composer = screen.getByRole("textbox", { name: "Message Chief" });
    composer.textContent = "Later local draft";
    await fireEvent.input(composer);
    await fireEvent.click(screen.getByRole("button", { name: "Studio Mac server" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Studio Mac server" })).toHaveAttribute("aria-pressed", "true"),
    );

    resolveTranscription?.({ text: "Message for local Chief" });
    await waitFor(() => expect(window.danidex.agent.sendMessage).toHaveBeenCalledOnce());
    expect(screen.queryByText("Local send failed")).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Local server" }));
    expect(await screen.findByText("Local send failed")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message Chief" })).toHaveTextContent(
      "Later local draft Message for local Chief",
    );
  });

  // The Linux package carries no whisper binary, so the composer must not offer a control that
  // always fails. Everything else about the window, the server rail included, stays the same.
  it("offers no microphone on Linux and still draws the server rail", async () => {
    vi.mocked(window.danidex.getAppInfo).mockResolvedValue({
      name: "Dani-Dex",
      version: "0.1.0",
      platform: "linux",
      variant: "production",
    });
    render(() => <App />);

    await screen.findByRole("heading", { name: "Chief" });

    expect(await screen.findByRole("complementary", { name: "Servers" })).toBeInTheDocument();
    expect(await screen.findByRole("textbox", { name: "Message Chief" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create prompt with voice" })).not.toBeInTheDocument();
  });

  it.each(["", "[BLANK_AUDIO] [BLANK_AUDIO] [BLANK_AUDIO]", "[silence]"])(
    "keeps no-input %j silent without dispatch or synthesis",
    async (text) => {
      installVoiceRecordingMocks();
      vi.mocked(window.danidex.voice.transcribe).mockResolvedValue({ text });
      render(() => <App />);
      await screen.findByRole("heading", { name: "Chief" });
      await fireEvent(
        await screen.findByRole("button", { name: "Create prompt with voice" }),
        dictationPointerEvent("pointerdown"),
      );
      await screen.findByRole("group", { name: "Voice recording" });
      await fireEvent(window, dictationPointerEvent("pointerup"));
      await screen.findByText("No speech was detected.");
      expect(window.danidex.agent.sendMessage).not.toHaveBeenCalled();
      expect(window.danidex.voice.speakLocal).not.toHaveBeenCalled();
    },
  );

  it("uses deliberate Command hold and never captures Command+C", async () => {
    installVoiceRecordingMocks();
    localStorage.removeItem("dani-dex.talk-key.v1");
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    vi.useFakeTimers();
    await fireEvent.keyDown(window, { key: "Meta", metaKey: true });
    await fireEvent.keyDown(window, { key: "c", metaKey: true });
    await vi.advanceTimersByTimeAsync(350);
    vi.useRealTimers();
    expect(window.danidex.voice.prepareModel).not.toHaveBeenCalled();
    await fireEvent.keyUp(window, { key: "Meta" });
    await fireEvent.keyDown(window, { key: "Meta", metaKey: true });
    await screen.findByRole("group", { name: "Voice recording" });
    await fireEvent.keyUp(window, { key: "Meta" });
    await waitFor(() => expect(window.danidex.agent.sendMessage).toHaveBeenCalledOnce());
  });

  it("submits hold-to-talk exactly once on its own pointer release", async () => {
    installVoiceRecordingMocks();
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await fireEvent(
      await screen.findByRole("button", { name: "Create prompt with voice" }),
      dictationPointerEvent("pointerdown"),
    );
    await screen.findByRole("group", { name: "Voice recording" });
    await fireEvent(window, dictationPointerEvent("pointerup", 2));
    await fireEvent(window, dictationPointerEvent("pointercancel", 2));
    expect(screen.getByRole("group", { name: "Voice recording" })).toBeVisible();
    expect(window.danidex.voice.transcribe).not.toHaveBeenCalled();
    expect(window.danidex.agent.sendMessage).not.toHaveBeenCalled();
    await fireEvent(window, dictationPointerEvent("pointerup"));
    await fireEvent(window, dictationPointerEvent("pointerup"));
    await waitFor(() => expect(window.danidex.voice.transcribe).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(window.danidex.agent.sendMessage).toHaveBeenCalledWith(
        { agentId: "chief", text: "Voice transcript", attachmentDraftIds: [] },
        "local",
      ),
    );
    expect(window.danidex.agent.sendMessage).toHaveBeenCalledOnce();
  });

  it.each(["pointercancel", "blur", "Escape"] as const)(
    "discards hold-to-talk on %s without saving or sending",
    async (reason) => {
      const { stopTrack } = installVoiceRecordingMocks();
      render(() => <App />);
      const composer = await screen.findByRole("textbox", {
        name: "Message Chief",
      });
      composer.textContent = "Keep this draft";
      await fireEvent.input(composer);
      await fireEvent(
        screen.getByRole("button", { name: "Create prompt with voice" }),
        dictationPointerEvent("pointerdown"),
      );
      await screen.findByRole("group", { name: "Voice recording" });
      if (reason === "pointercancel") await fireEvent(window, dictationPointerEvent("pointercancel"));
      else if (reason === "blur") await fireEvent.blur(window);
      else await fireEvent.keyDown(window, { key: "Escape" });
      await fireEvent(window, dictationPointerEvent("pointerup"));

      expect(await screen.findByRole("button", { name: "Create prompt with voice" })).toBeEnabled();
      expect(stopTrack).toHaveBeenCalledOnce();
      expect(window.danidex.voice.transcribe).not.toHaveBeenCalled();
      expect(window.danidex.agent.sendMessage).not.toHaveBeenCalled();
      expect(composer).toHaveTextContent("Keep this draft");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    },
  );

  it("cancels an unmounted hold-to-talk without transcribing recorder stop data", async () => {
    const { stream, stopTrack } = installVoiceRecordingMocks();
    const view = render(() => <App />);
    await fireEvent(
      await screen.findByRole("button", { name: "Create prompt with voice" }),
      dictationPointerEvent("pointerdown"),
    );
    await screen.findByRole("group", { name: "Voice recording" });
    view.unmount();
    await fireEvent(window, dictationPointerEvent("pointerup"));
    expect(stopTrack).toHaveBeenCalled();
    expect(stream.getAudioTracks()[0]?.readyState).toBe("ended");
    expect(window.danidex.voice.transcribe).not.toHaveBeenCalled();
    expect(window.danidex.agent.sendMessage).not.toHaveBeenCalled();
  });

  it("does not request the microphone after release during model preparation", async () => {
    installVoiceRecordingMocks();
    let resolvePreparation: ((status: VoiceModelStatus) => void) | undefined;
    const preparation = new Promise<VoiceModelStatus>((resolve) => {
      resolvePreparation = resolve;
    });
    vi.mocked(window.danidex.voice.prepareModel).mockReturnValueOnce(preparation);
    render(() => <App />);
    await fireEvent(
      await screen.findByRole("button", { name: "Create prompt with voice" }),
      dictationPointerEvent("pointerdown"),
    );
    await waitFor(() => expect(window.danidex.voice.prepareModel).toHaveBeenCalledOnce());
    await fireEvent(window, dictationPointerEvent("pointerup"));
    await fireEvent.click(screen.getByRole("button", { name: "Create prompt with voice" }), { detail: 1 });
    expect(window.danidex.voice.prepareModel).toHaveBeenCalledOnce();
    resolvePreparation?.({ phase: "ready", progress: 100, message: null });
    await preparation;
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(window.danidex.voice.transcribe).not.toHaveBeenCalled();
    expect(window.danidex.agent.sendMessage).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Create prompt with voice" })).toBeEnabled();
  });

  it.each(["pointerup", "pointercancel", "blur", "Escape", "unmount"] as const)(
    "releases late microphone tracks after %s during microphone preparation",
    async (reason) => {
      const { stream, stopTrack } = installVoiceRecordingMocks();
      let resolveMicrophone: ((stream: MediaStream) => void) | undefined;
      vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementationOnce(
        () =>
          new Promise<MediaStream>((resolve) => {
            resolveMicrophone = resolve;
          }),
      );
      const view = render(() => <App />);
      await fireEvent(
        await screen.findByRole("button", { name: "Create prompt with voice" }),
        dictationPointerEvent("pointerdown"),
      );
      await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce());
      if (reason === "pointerup" || reason === "pointercancel") {
        await fireEvent(window, dictationPointerEvent(reason));
      } else if (reason === "blur") await fireEvent.blur(window);
      else if (reason === "Escape") await fireEvent.keyDown(window, { key: "Escape" });
      else view.unmount();
      resolveMicrophone?.(stream);
      await waitFor(() => expect(stopTrack).toHaveBeenCalledOnce());
      expect(window.danidex.voice.transcribe).not.toHaveBeenCalled();
      expect(window.danidex.agent.sendMessage).not.toHaveBeenCalled();
      if (reason !== "unmount") {
        expect(screen.getByRole("button", { name: "Create prompt with voice" })).toBeEnabled();
        expect(screen.getByRole("textbox", { name: "Message Chief" })).toHaveTextContent("");
      }
    },
  );

  it("keeps keyboard activation available after a cancelled pointer gesture", async () => {
    installVoiceRecordingMocks();
    render(() => <App />);
    await fireEvent(
      await screen.findByRole("button", { name: "Create prompt with voice" }),
      dictationPointerEvent("pointerdown"),
    );
    await screen.findByRole("group", { name: "Voice recording" });
    await fireEvent(window, dictationPointerEvent("pointercancel"));
    const button = await screen.findByRole("button", {
      name: "Create prompt with voice",
    });
    button.focus();
    await fireEvent.click(button, { detail: 0 });
    await screen.findByRole("group", { name: "Voice recording" });
    await fireEvent.click(screen.getByRole("button", { name: "Stop voice recording" }));
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Message Chief" })).toHaveTextContent("Voice transcript"),
    );
    expect(window.danidex.agent.sendMessage).not.toHaveBeenCalled();
  });

  it("starts a local voice call without OpenAI Realtime", async () => {
    installVoiceRecordingMocks();
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await fireEvent.click(await screen.findByRole("button", { name: "Start voice call" }));
    expect(await screen.findByRole("button", { name: "End voice call" })).toBeInTheDocument();
    expect(window.danidex.voice.prepareModel).toHaveBeenCalled();
    expect(window.danidex.voice.createRealtimeSession).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Use your voice" })).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "End voice call" }));
    expect(await screen.findByRole("button", { name: "Start voice call" })).toBeInTheDocument();
  });

  it("starts deliberate dictation without an extra app confirmation", async () => {
    installVoiceRecordingMocks();
    vi.mocked(window.confirm).mockClear();
    render(() => <App />);
    await fireEvent.click(await screen.findByRole("button", { name: "Create prompt with voice" }));
    await screen.findByRole("group", { name: "Voice recording" });
    expect(window.confirm).not.toHaveBeenCalled();
    expect(window.danidex.voice.requestMicrophoneAccess).toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: "Stop voice recording" }));
  });

  it("allows deliberate Command hold while the composer has focus", async () => {
    installVoiceRecordingMocks();
    localStorage.removeItem("dani-dex.talk-key.v1");
    render(() => <App />);
    const composer = await screen.findByRole("textbox", {
      name: "Message Chief",
    });
    composer.focus();
    await fireEvent.keyDown(composer, { key: "Meta", metaKey: true });
    await screen.findByRole("group", { name: "Voice recording" });
    await fireEvent.keyDown(window, { key: "Escape" });
    await fireEvent.keyUp(window, { key: "Meta" });
    expect(window.danidex.agent.sendMessage).not.toHaveBeenCalled();
  });

  it("keeps the production composer free of speech pickers and test buttons", async () => {
    render(() => <App />);
    await screen.findByRole("textbox", { name: "Message Chief" });
    expect(screen.queryByRole("combobox", { name: "Speech recognition" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "Start background voice prototype",
      }),
    ).not.toBeInTheDocument();
  });
});
