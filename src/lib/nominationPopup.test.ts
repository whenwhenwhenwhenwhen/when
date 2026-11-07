import { describe, expect, it } from "vitest";
import { getNominationPopupStyle } from "./nominationPopup";

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
    expect(style.maxHeight).toBeCloseTo(345.6);
    expect(style.top).toBe(150);
    expect(Number(style.left) + Number(style.width)).toBeLessThanOrEqual(792);
  });

  it("does not show a box when the requested distance leaves no room", () => {
    expect(getNominationPopupStyle({ x: 400, y: 300 }, { width: 800, height: 600 }, 1000)).toBeUndefined();
  });
});
