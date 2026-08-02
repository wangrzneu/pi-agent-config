import type { Component, TUI } from "@earendil-works/pi-tui";
import { CURSOR_MARKER, Input } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

export class MaskedPasswordInput implements Component {
  private readonly input = new Input();
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly title: string;

  constructor(
    tui: TUI,
    theme: Theme,
    title: string,
    done: (value: string | undefined) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.title = title;
    this.input.focused = true;
    this.input.onSubmit = (value) => done(value);
    this.input.onEscape = () => done(undefined);
  }

  handleInput(data: string): void {
    this.input.handleInput(data);
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const available = Math.max(1, width - 2);
    const length = [...this.input.getValue()].length;
    const hidden = "•".repeat(Math.min(length, available));
    return [
      this.theme.fg("accent", this.title),
      this.theme.fg("text", `${hidden}${CURSOR_MARKER}`),
      this.theme.fg("dim", "Enter to continue · Esc to cancel"),
    ];
  }
}
