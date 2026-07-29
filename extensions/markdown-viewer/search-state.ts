export class SearchState {
  private matches: number[] = [];
  private cursor = -1;

  query = "";
  draft = "";

  begin(): void {
    this.draft = this.query;
  }

  commit(): void {
    this.query = this.draft;
    this.cursor = -1;
  }

  cancel(): void {
    this.draft = this.query;
  }

  setDraft(value: string): void {
    this.draft = value;
  }

  update(lines: string[]): void {
    const query = this.query.trim().toLocaleLowerCase();
    this.matches = query
      ? lines.flatMap((line, index) =>
          line.toLocaleLowerCase().includes(query) ? [index] : [],
        )
      : [];
    if (this.matches.length === 0) this.cursor = -1;
    else if (this.cursor >= this.matches.length) this.cursor = 0;
  }

  move(direction: 1 | -1): number | undefined {
    if (this.matches.length === 0) return undefined;
    if (this.cursor < 0) {
      this.cursor = direction === 1 ? 0 : this.matches.length - 1;
    } else {
      this.cursor =
        (this.cursor + direction + this.matches.length) % this.matches.length;
    }
    return this.matches[this.cursor];
  }

  get currentLine(): number | undefined {
    return this.cursor < 0 ? undefined : this.matches[this.cursor];
  }

  get matchLines(): readonly number[] {
    return this.matches;
  }

  get position(): string {
    if (!this.query) return "";
    if (this.matches.length === 0) return "0/0";
    return `${Math.max(0, this.cursor) + 1}/${this.matches.length}`;
  }
}
