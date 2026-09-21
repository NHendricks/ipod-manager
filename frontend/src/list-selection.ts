// Multi-selection with a keyboard cursor, shared by local-pane and ipod-pane. Works on the list of
// currently visible row ids; the owning component re-renders after calling any method here.
export class ListSelection {
  selected = new Set<string>()
  cursor = -1
  private anchor = -1

  /** `isSelectable` lets a list have rows the cursor can rest on but that never get selected (folders). */
  constructor(private isSelectable: (id: string) => boolean = () => true) {}

  clear(): void {
    this.selected.clear()
    this.cursor = -1
    this.anchor = -1
  }

  /** Mouse click on row `index`: plain = select only it, Ctrl = toggle it, Shift = range from the anchor. */
  click(ids: string[], index: number, shift: boolean, ctrl: boolean): void {
    const id = ids[index]
    if (shift && this.anchor >= 0) {
      this.selectRange(ids, this.anchor, index)
    } else if (ctrl) {
      if (this.selected.has(id)) this.selected.delete(id)
      else if (this.isSelectable(id)) this.selected.add(id)
      this.anchor = index
    } else {
      this.selected.clear()
      if (this.isSelectable(id)) this.selected.add(id)
      this.anchor = index
    }
    this.cursor = index
  }

  /**
   * Ctrl+A, arrows, Page Up/Down, Home/End (with Shift = extend the selection from the anchor).
   * Returns true if the key was handled. `pageSize` is how many rows fit on screen.
   */
  handleKey(e: KeyboardEvent, ids: string[], pageSize: number): boolean {
    if (ids.length === 0) return false
    const last = ids.length - 1

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      this.selected = new Set(ids.filter(this.isSelectable))
      return true
    }

    const base = this.cursor < 0 ? -1 : Math.min(this.cursor, last)
    let target: number
    switch (e.key) {
      case 'ArrowDown': target = base + 1; break
      case 'ArrowUp': target = base - 1; break
      case 'PageDown': target = base + pageSize; break
      case 'PageUp': target = base - pageSize; break
      case 'Home': target = 0; break
      case 'End': target = last; break
      default: return false
    }
    target = Math.max(0, Math.min(last, target))

    if (e.shiftKey) {
      if (this.anchor < 0) this.anchor = Math.max(base, 0)
      this.selectRange(ids, this.anchor, target)
    } else {
      this.selected.clear()
      if (this.isSelectable(ids[target])) this.selected.add(ids[target])
      this.anchor = target
    }
    this.cursor = target
    return true
  }

  private selectRange(ids: string[], from: number, to: number): void {
    const [lo, hi] = from <= to ? [from, to] : [to, from]
    this.selected = new Set(ids.slice(lo, hi + 1).filter(this.isSelectable))
  }
}
