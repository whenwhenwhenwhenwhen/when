import { describe, expect, it } from "vitest";
import { getNominationPopupStyle, getNominationSummary, splitNominationColumns } from "./nominationPopup";

describe("nomination popup positioning", () => {
  it.each([
    { x: 0, y: 0 },
    { x: 800, y: 0 },
    { x: 0, y: 600 },
    { x: 800, y: 600 },
    { x: 200, y: 300 },
  ])("preserves cursor distance and viewport bounds at $x,$y", (cursor) => {
    const viewport = { width: 800, height: 600 };
    for (const distance of [0, 50, 120, 300]) {
      const style = getNominationPopupStyle(cursor, viewport, distance)!;
      expect(style).toBeDefined();
      const width = Number(style.width);
      const height = Number(style.maxHeight);
      const left = style.left === undefined ? viewport.width - Number(style.right) - width : Number(style.left);
      const top = style.top === undefined ? viewport.height - Number(style.bottom) - height : Number(style.top);
      const dx = Math.max(left - cursor.x, cursor.x - left - width, 0);
      const dy = Math.max(top - cursor.y, cursor.y - top - height, 0);
      expect(Math.hypot(dx, dy)).toBeGreaterThanOrEqual(distance);
      expect(left).toBeGreaterThanOrEqual(8);
      expect(top).toBeGreaterThanOrEqual(8);
      expect(left + width).toBeLessThanOrEqual(viewport.width - 8);
      expect(top + height).toBeLessThanOrEqual(viewport.height - 8);
    }
  });

  it("uses the current cursor coordinates when it moves", () => {
    const viewport = { width: 800, height: 600 };
    expect(getNominationPopupStyle({ x: 250, y: 200 }, viewport, 75)?.top).toBe(275);
    expect(getNominationPopupStyle({ x: 250, y: 225 }, viewport, 75)?.top).toBe(300);
  });

  it("sizes the popup in rems when the app uses a larger root font", () => {
    const style = getNominationPopupStyle({ x: 400, y: 100 }, { width: 800, height: 600 }, 50, 19.2)!;
    expect(style.width).toBeCloseTo(499.2);
    expect(style.maxHeight).toBe(442);
    expect(style.top).toBe(150);
    expect(Number(style.left) + Number(style.width)).toBeLessThanOrEqual(792);
  });

  it("widens within the viewport while using all available height", () => {
    const style = getNominationPopupStyle({ x: 790, y: 100 }, { width: 800, height: 1000 }, 50, 16, 1200)!;
    expect(style.width).toBe(784);
    expect(style.left).toBe(8);
    expect(style.maxHeight).toBe(842);
  });

  it("does not show a box when the requested distance leaves no room", () => {
    expect(getNominationPopupStyle({ x: 400, y: 300 }, { width: 800, height: 600 }, 1000)).toBeUndefined();
  });

});

describe("nomination summary", () => {
  it.each([
    { canDo: 0, maybe: 0, total: 0, available: 0, color: "red" },
    { canDo: 0, maybe: 0, total: 5, available: 0, color: "red" },
    { canDo: 2, maybe: 1, total: 7, available: 3, color: "red" },
    { canDo: 2, maybe: 1, total: 6, available: 3, color: "yellow" },
    { canDo: 2, maybe: 1, total: 5, available: 3, color: "yellow" },
    { canDo: 5, maybe: 0, total: 5, available: 5, color: "green" },
    { canDo: 3, maybe: 2, total: 5, available: 5, color: "green" },
    { canDo: 0, maybe: 5, total: 5, available: 5, color: "green" },
  ])("counts can plus maybe and classifies $available/$total as $color", ({ canDo, maybe, total, available, color }) => {
    expect(getNominationSummary(canDo, maybe, total)).toEqual({ available, maybe, total, color });
  });
});

describe("nomination columns", () => {
  it("fills the available height before adding columns without losing or reordering people", () => {
    const people = [30, 40, 50, 20, 30, 60, 20];
    const columns = splitNominationColumns(people, 100, (height) => height);
    expect(columns).toEqual([[30, 40], [50, 20, 30], [60, 20]]);
    expect(columns.flat()).toEqual(people);
    expect(columns.every((column) => column.reduce((total, height) => total + height, 0) <= 100)).toBe(true);
    expect(splitNominationColumns(people, 300, (height) => height)).toEqual([people]);
  });

  it("keeps empty statuses and participants taller than the available space", () => {
    expect(splitNominationColumns([], 100, () => 30)).toEqual([[]]);
    expect(splitNominationColumns([150, 40], 100, (height) => height)).toEqual([[150], [40]]);
    expect(splitNominationColumns([30, 40], 0, (height) => height)).toEqual([[30], [40]]);
  });
});
