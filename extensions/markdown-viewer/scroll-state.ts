export class ScrollState {
  private offset = 0;
  private contentLines = 0;
  private viewportLines = 1;

  update(contentLines: number, viewportLines: number): void {
    this.contentLines = Math.max(0, contentLines);
    this.viewportLines = Math.max(1, viewportLines);
    this.clamp();
  }

  move(lines: number): void {
    this.offset += lines;
    this.clamp();
  }

  movePage(pages: number): void {
    this.move(pages * Math.max(1, this.viewportLines - 1));
  }

  moveToStart(): void {
    this.offset = 0;
  }

  moveToEnd(): void {
    this.offset = this.maxOffset;
  }

  get start(): number {
    return this.offset;
  }

  get end(): number {
    return Math.min(this.contentLines, this.offset + this.viewportLines);
  }

  get total(): number {
    return this.contentLines;
  }

  private get maxOffset(): number {
    return Math.max(0, this.contentLines - this.viewportLines);
  }

  private clamp(): void {
    this.offset = Math.max(0, Math.min(this.offset, this.maxOffset));
  }
}
